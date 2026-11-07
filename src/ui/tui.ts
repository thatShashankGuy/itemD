import { realpath } from "node:fs/promises";
import {
  runAgent,
  type AgentRunResult,
} from "../agent/runner.ts";
import {
  type ConfigurationOptions,
  type ItemDConfiguration,
  resolveConfiguration,
} from "../config/configuration.ts";
import type { ModelAdapter } from "../model/adapter.ts";
import { PROVIDER_CATALOG } from "../model/catalog.ts";
import { createModelAdapter } from "../model/factory.ts";
import { getErrorMessage, isRecord } from "../shared/runtime.ts";
import { createSerperSearchProvider } from "../web/provider.ts";
import type { SearchProvider } from "../web/provider.ts";
import {
  listTraces,
  replayTrace,
  type ReplayResult,
} from "../telemetry/trace.ts";
import {
  formatTuiCommandHelp,
  TUI_COMMANDS,
} from "./commands.ts";
import {
  runSetup,
  type TuiIO,
} from "./setup.ts";
import {
  executePrefixedShellCommand,
  formatShellResult,
} from "./shell.ts";

export {
  runSetup,
  TerminalTuiIO,
  type QuestionOptions,
  type SetupResult,
  type TuiIO,
} from "./setup.ts";

const PROMPT = "itemD> ";

function writeLine(io: TuiIO, text = ""): void {
  io.write(`${text}\n`);
}

function printHelp(io: TuiIO): void {
  writeLine(io, "Commands:");
  for (const line of formatTuiCommandHelp().split("\n")) {
    writeLine(io, `  ${line}`);
  }
  writeLine(io, "  exit()               Exit the interface");
  writeLine(io);
  writeLine(io, "Prefix a command with ! to run it through the shell policy.");
  writeLine(io, "Any other input starts a new independent agent task.");
}

function printAgentResult(io: TuiIO, result: AgentRunResult): void {
  writeLine(io);

  if (result.ok) {
    writeLine(io, `[done] ${result.answer}`);
  } else {
    writeLine(io, `[${result.status}] ${result.error.message}`);
  }

  writeLine(io, `steps: ${result.steps}`);
  writeLine(io, `trace: ${result.traceId}`);
  writeLine(io);
}

function withoutReasoning(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutReasoning);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "reasoning")
      .map(([key, entry]) => [key, withoutReasoning(entry)]),
  );
}

function printReplayResult(
  io: TuiIO,
  result: ReplayResult,
  includeReasoning: boolean,
): void {
  writeLine(
    io,
    JSON.stringify(
      includeReasoning ? result : withoutReasoning(result),
      null,
      2,
    ),
  );
  writeLine(io);
}

function printActiveConfiguration(
  io: TuiIO,
  configuration: ItemDConfiguration,
): void {
  const provider = PROVIDER_CATALOG.find(
    (candidate) => candidate.id === configuration.provider,
  );
  const effort = provider?.enabled
    ? provider.reasoningEfforts.find(
        (candidate) => candidate.id === configuration.effort,
      )
    : undefined;

  writeLine(io, "Active configuration:");
  writeLine(io, `  provider: ${provider?.displayName ?? configuration.provider}`);
  writeLine(io, `  model: ${configuration.model}`);
  writeLine(io, `  effort: ${effort?.displayName ?? configuration.effort}`);
  writeLine(
    io,
    `  web search: ${configuration.webSearch?.enabled ? "enabled" : "disabled"}`,
  );
}

export type ActiveConfiguration = {
  configuration: ItemDConfiguration;
  adapter: ModelAdapter;
  webSearchProvider?: SearchProvider;
};

export async function resolveActiveConfiguration(
  io: TuiIO,
  configOptions: ConfigurationOptions,
): Promise<ActiveConfiguration | null> {
  const result = await resolveConfiguration(configOptions);

  if (!result.ok) {
    writeLine(io, `[configuration error] ${result.error.message}`);
    return null;
  }

  if (result.configuration === null) {
    return null;
  }

  const adapterResult = createModelAdapter(result.configuration);

  if (!adapterResult.ok) {
    writeLine(io, `[configuration error] ${adapterResult.error.message}`);
    return null;
  }

  const webSearchProvider =
    result.configuration.webSearch?.enabled === true
      ? createSerperSearchProvider({
          apiKey: result.configuration.webSearch.serperApiKey,
        })
      : undefined;

  return {
    configuration: result.configuration,
    adapter: adapterResult.adapter,
    ...(webSearchProvider === undefined ? {} : { webSearchProvider }),
  };
}

async function handleReplay(
  io: TuiIO,
  workspaceRoot: string,
  words: string[],
  includeReasoning: boolean,
): Promise<void> {
  if (words.length !== 2) {
    writeLine(io, "Usage: /replay <trace-id>");
    writeLine(io);
    return;
  }

  const traceId = words[1];

  if (traceId === undefined) {
    return;
  }

  const result = await replayTrace(workspaceRoot, traceId);
  printReplayResult(io, result, includeReasoning);
}

async function handleReplayList(
  io: TuiIO,
  workspaceRoot: string,
  includeReasoning: boolean,
): Promise<void> {
  const result = await listTraces(workspaceRoot);

  if (!result.ok) {
    writeLine(io, `[replay error] ${result.error.message}`);
    writeLine(io);
    return;
  }

  if (result.traces.length === 0) {
    writeLine(io, "No recorded runs.");
    writeLine(io);
    return;
  }

  writeLine(io, "Select a replay (newest first):");

  result.traces.forEach((trace, index) => {
    writeLine(io, `  ${index + 1}. ${trace.traceId}  ${trace.modifiedAt}`);
  });

  const answer = await io.question("Replay: ");

  if (answer === null) {
    return;
  }

  const index = Number(answer.trim()) - 1;
  const trace = Number.isInteger(index)
    ? result.traces[index]
    : undefined;

  if (trace === undefined) {
    writeLine(io, "Replay selection cancelled or invalid.");
    writeLine(io);
    return;
  }

  await handleReplay(
    io,
    workspaceRoot,
    ["/replay", trace.traceId],
    includeReasoning,
  );
  writeLine(io);
}

export type RunTuiOptions = {
  io?: TuiIO;
  workspaceRoot?: string;
  config?: ConfigurationOptions;
};

export async function runTui(
  options: RunTuiOptions = {},
): Promise<void> {
  const workspaceRoot =
    options.workspaceRoot ?? (await realpath(process.cwd()));
  const configOptions = options.config ?? {};

  if (options.io === undefined) {
    const { runOpenTui } = await import("./opentui.ts");
    await runOpenTui({ workspaceRoot, config: configOptions });
    return;
  }

  const io = options.io;

  writeLine(io, "itemD — Minimal Coding Harness");
  writeLine(io, `workspace: ${workspaceRoot}`);

  let active = await resolveActiveConfiguration(io, configOptions);

  if (active === null) {
    const setupResult = await runSetup(io, configOptions);

    if (setupResult.status !== "saved") {
      io.close();
      writeLine(io, "Goodbye.");
      return;
    }

    active = await resolveActiveConfiguration(io, configOptions);

    if (active === null) {
      io.close();
      writeLine(io, "Goodbye.");
      return;
    }
  }

  printActiveConfiguration(io, active.configuration);
  writeLine(io, "Type /help for commands. Each task starts a new run.");
  writeLine(io);

  let streamReasoning = false;

  try {
    while (!io.interrupted) {
      const answer = await io.question(PROMPT);

      if (answer === null) {
        break;
      }

      const line = answer.trim();

      if (line.length === 0) {
        continue;
      }

      const words = line.split(/\s+/);
      const command = words[0];

      if (
        command === "/quit" ||
        command === "/exit" ||
        command === "exit" ||
        command === "exit()"
      ) {
        break;
      }

      if (command === "/help") {
        printHelp(io);
        continue;
      }

      if (command === "/config") {
        printActiveConfiguration(io, active.configuration);
        writeLine(io);
        continue;
      }

      if (command === "/reasoning") {
        const requested = words[1]?.toLowerCase();

        if (
          requested !== undefined &&
          requested !== "on" &&
          requested !== "off"
        ) {
          writeLine(io, "Usage: /reasoning [on|off]");
        } else {
          streamReasoning = requested === undefined
            ? !streamReasoning
            : requested === "on";
          writeLine(
            io,
            `Replay reasoning ${streamReasoning ? "enabled" : "disabled"}.`,
          );
        }

        writeLine(io);
        continue;
      }

      if (command === "/reload") {
        const replacement = await resolveActiveConfiguration(
          io,
          configOptions,
        );

        if (replacement === null) {
          writeLine(io, "Reload failed. Keeping the previous configuration.");
        } else {
          active = replacement;
          writeLine(io, "Configuration reloaded.");
          printActiveConfiguration(io, active.configuration);
        }

        writeLine(io);
        continue;
      }

      if (command === "/setup" || command === "/adapter") {
        const setupResult = await runSetup(io, configOptions);

        if (setupResult.status === "saved") {
          const replacement = await resolveActiveConfiguration(
            io,
            configOptions,
          );

          if (replacement !== null) {
            active = replacement;
            printActiveConfiguration(io, active.configuration);
          } else {
            writeLine(io, "Keeping the previous active configuration.");
          }
        } else if (setupResult.status === "cancelled") {
          writeLine(io, "Setup cancelled. Keeping the previous configuration.");
        }

        writeLine(io);
        continue;
      }

      if (command === "/clear") {
        io.write("\u001B[2J\u001B[H");
        continue;
      }

      if (command === "/new") {
        io.write("\u001B[2J\u001B[H");
        writeLine(io, "New session started. Active configuration retained.");
        writeLine(io);
        continue;
      }

      if (command === "/replay") {
        await handleReplay(io, workspaceRoot, words, streamReasoning);
        continue;
      }

      if (command === "/replays") {
        await handleReplayList(io, workspaceRoot, streamReasoning);
        continue;
      }

      if (line.startsWith("!")) {
        const shellInput = line.slice(1).trim();
        const shellResult = await executePrefixedShellCommand(
          shellInput,
          workspaceRoot,
        );
        writeLine(io, formatShellResult(shellInput, shellResult));
        writeLine(io);
        continue;
      }

      if (command?.startsWith("/")) {
        writeLine(io, `Unknown command: ${command}`);
        writeLine(
          io,
          `Type /help for ${TUI_COMMANDS.length} available commands.`,
        );
        writeLine(io);
        continue;
      }

      writeLine(io, `Running with ${active.configuration.model}...`);

      try {
        const result = await runAgent(
          line,
          active.adapter,
          workspaceRoot,
          {
            tools: {
              ...(active.webSearchProvider === undefined
                ? {}
                : { webSearchProvider: active.webSearchProvider }),
            },
            onEvent: (event) => {
              if (streamReasoning && event.type === "reasoning") {
                writeLine(io, `[reasoning step ${event.step}] ${event.text}`);
              }
            },
          },
        );

        printAgentResult(io, result);
      } catch (error: unknown) {
        writeLine(io, `[itemD error] ${getErrorMessage(error)}`);
        writeLine(io);
      }
    }
  } finally {
    io.close();
  }

  writeLine(io, "Goodbye.");
}
