import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  runAgent,
  type AgentRunResult,
} from "../agent/runner.ts";
import type { AgentRuntimeEvent } from "../agent/events.ts";
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
  SessionService,
  type SessionContext,
} from "../session/service.ts";
import { presentSessionMessage } from "../session/presentation.ts";
import { openSessionStore } from "../session/store.ts";
import {
  ShellApprovalController,
  type ShellApprovalRequest,
  type ShellExecutionMode,
} from "../permissions/shell-approval.ts";
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
import type { EditorComposerOptions } from "./editor.ts";

export {
  runSetup,
  TerminalTuiIO,
  type QuestionOptions,
  type SetupResult,
  type TuiIO,
} from "./setup.ts";

const PROMPT = "itemd> ";

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
  writeLine(io, "In the full-screen terminal composer, type $editor to compose in your default editor.");
  writeLine(io, "Any other input starts a new independent agent task.");
}

function printAgentResult(
  io: TuiIO,
  result: AgentRunResult,
  streamedResponse = false,
): void {
  writeLine(io);

  if (result.ok) {
    writeLine(
      io,
      streamedResponse ? "[done] Response complete." : `[done] ${result.answer}`,
    );
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

function printSessionHistory(
  io: TuiIO,
  messages: SessionContext["messages"],
): void {
  if (messages.length === 0) {
    return;
  }

  writeLine(io, "Restored session history:");
  for (const message of messages) {
    const presented = presentSessionMessage(message);
    writeLine(io, `${presented.label}: ${presented.text}`);
  }
  writeLine(io);
}

function formatShellApprovalCommand(request: ShellApprovalRequest): string {
  return [request.call.executable, ...request.call.args]
    .map((part) => JSON.stringify(part))
    .join(" ");
}

function createTuiShellApproval(
  io: TuiIO,
): ShellApprovalController {
  return new ShellApprovalController(async (request) => {
    writeLine(io);
    writeLine(io, "The model requested this shell command:");
    writeLine(io, `  ${formatShellApprovalCommand(request)}`);
    writeLine(io, "  1. approve once");
    writeLine(io, "  2. approve this exact command for later");
    writeLine(io, "  3. deny");

    while (true) {
      const answer = await io.question("Approval [1/2/3]: ");

      if (answer === null) {
        return "deny";
      }

      const choice = answer.trim().toLowerCase();

      if (choice === "1" || choice === "once" || choice === "y") {
        return "once";
      }

      if (choice === "2" || choice === "always" || choice === "a") {
        return "always";
      }

      if (choice === "3" || choice === "deny" || choice === "n") {
        return "deny";
      }

      writeLine(io, "Choose 1, 2, or 3.");
    }
  });
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
  resumeSessionId?: string;
  sessionDbPath?: string;
  shellMode?: ShellExecutionMode;
  workspaceRoot?: string;
  config?: ConfigurationOptions;
  editor?: Pick<EditorComposerOptions, "env" | "tempDirectory" | "execute">;
};

function getTuiSessionDbPath(
  options: RunTuiOptions,
  config: ConfigurationOptions,
): string | undefined {
  if (options.sessionDbPath !== undefined) {
    return options.sessionDbPath;
  }

  if (config.env?.ITEMD_SESSION_DB_PATH !== undefined) {
    return undefined;
  }

  if (config.configPath !== undefined) {
    return join(dirname(resolve(config.configPath)), "sessions.db");
  }

  return undefined;
}

export async function runTui(
  options: RunTuiOptions = {},
): Promise<void> {
  const workspaceRoot =
    options.workspaceRoot ?? (await realpath(process.cwd()));
  const configOptions = options.config ?? {};

  if (options.io === undefined) {
    const { runOpenTui } = await import("./opentui.ts");
    await runOpenTui({
      workspaceRoot,
      config: configOptions,
      ...(options.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: options.resumeSessionId }),
      ...(options.sessionDbPath === undefined
        ? {}
        : { sessionDbPath: options.sessionDbPath }),
      ...(options.shellMode === undefined
        ? {}
        : { shellMode: options.shellMode }),
      ...(options.editor === undefined ? {} : { editor: options.editor }),
    });
    return;
  }

  const io = options.io;
  const shellApproval = createTuiShellApproval(io);

  writeLine(io, "itemd — Minimal Coding Harness");
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

  const sessionDbPath = getTuiSessionDbPath(options, configOptions);
  const sessionStore = await openSessionStore({
    ...(sessionDbPath === undefined ? {} : { dbPath: sessionDbPath }),
    ...(configOptions.env === undefined ? {} : { env: configOptions.env }),
  });
  const sessionService = new SessionService(sessionStore);
  let sessionContext: SessionContext;

  if (options.resumeSessionId !== undefined) {
    const resumed = sessionService.resumeSession(
      options.resumeSessionId,
      workspaceRoot,
    );

    if (!resumed.ok) {
      sessionService.close();
      io.close();
      writeLine(io, `[session error] ${resumed.error.message}`);
      writeLine(io, "Goodbye.");
      return;
    }

    sessionContext = resumed.context;
  } else {
    sessionContext = sessionService.createSession(workspaceRoot);
  }

  printActiveConfiguration(io, active.configuration);
  writeLine(io, `session: ${sessionContext.session.id}`);
  writeLine(io, "Type /help for commands. Messages are saved to this session.");
  printSessionHistory(io, sessionContext.messages);
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
        sessionContext = sessionService.createSession(workspaceRoot);
        io.write("\u001B[2J\u001B[H");
        writeLine(io, "New session started. Active configuration retained.");
        writeLine(io, `session: ${sessionContext.session.id}`);
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

      if (line === "$editor") {
        writeLine(
          io,
          "$editor is available in the full-screen terminal composer, not the line-oriented test interface.",
        );
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
        sessionContext = sessionService.appendMessage(
          sessionContext.session.id,
          { role: "user", content: line },
        );
        let streamedModelStep: number | null = null;
        let streamedModelText = "";
        let streamedOutputOpen = false;
        const closeStreamOutput = (): void => {
          if (streamedOutputOpen) {
            writeLine(io);
            streamedOutputOpen = false;
          }
        };
        const result = await runAgent(
          line,
          active.adapter,
          workspaceRoot,
          {
            tools: {
              shellMode: options.shellMode ?? "ask",
              shellApproval,
              ...(active.webSearchProvider === undefined
                ? {}
                : { webSearchProvider: active.webSearchProvider }),
            },
            initialMessages: sessionContext.messages,
            onMessage: (message) => {
              sessionContext = sessionService.appendMessage(
                sessionContext.session.id,
                message,
              );
            },
            onEvent: (event) => {
              if (streamReasoning && event.type === "reasoning") {
                writeLine(io, `[reasoning step ${event.step}] ${event.text}`);
              }
            },
            onRuntimeEvent: (event: AgentRuntimeEvent): void => {
              if (event.type === "model_delta") {
                if (streamedModelStep !== event.step) {
                  closeStreamOutput();
                  streamedModelStep = event.step;
                  streamedModelText = "";
                  io.write(`assistant step ${event.step}  `);
                  streamedOutputOpen = true;
                }

                streamedModelText += event.text;
                io.write(event.text);
                return;
              }

              if (event.type === "tool_started") {
                closeStreamOutput();
                writeLine(io, `tool  ${event.toolName} started`);
                return;
              }

              if (event.type === "tool_finished") {
                closeStreamOutput();
                writeLine(
                  io,
                  `tool  ${event.toolName} ${event.result.ok ? "completed" : "failed"}`,
                );
                return;
              }

              if (event.type === "run_completed" || event.type === "run_failed") {
                closeStreamOutput();
              }
            },
          },
        );

        closeStreamOutput();

        printAgentResult(io, result, streamedModelText.length > 0);
      } catch (error: unknown) {
        writeLine(io, `[itemd error] ${getErrorMessage(error)}`);
        writeLine(io);
      }
    }
  } finally {
    sessionService.close();
    io.close();
  }

  writeLine(io, "Goodbye.");
}
