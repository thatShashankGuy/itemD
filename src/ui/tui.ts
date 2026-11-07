import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
import { getErrorMessage } from "../shared/runtime.ts";
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

function printReplayResult(io: TuiIO, result: ReplayResult): void {
  writeLine(io, JSON.stringify(result, null, 2));
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
}

export type ActiveConfiguration = {
  configuration: ItemDConfiguration;
  adapter: ModelAdapter;
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

  return {
    configuration: result.configuration,
    adapter: adapterResult.adapter,
  };
}

async function handleReplay(
  io: TuiIO,
  workspaceRoot: string,
  words: string[],
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
  printReplayResult(io, result);
}

async function handleReplayList(
  io: TuiIO,
  workspaceRoot: string,
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

  writeLine(io, "Recorded runs (newest first):");

  for (const trace of result.traces) {
    writeLine(io, `  ${trace.traceId}  ${trace.modifiedAt}`);
  }

  writeLine(io, "Use /replay <trace-id> to display a run.");
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

      if (command === "/replay") {
        await handleReplay(io, workspaceRoot, words);
        continue;
      }

      if (command === "/replays") {
        await handleReplayList(io, workspaceRoot);
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

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isDirectExecution) {
  await runTui().catch((error: unknown) => {
    console.error(`[tui error] ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
