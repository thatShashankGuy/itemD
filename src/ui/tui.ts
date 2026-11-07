import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  stdin as input,
  stdout as output,
} from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  runAgent,
  type AgentRunResult,
} from "../agent/runner.ts";
import {
  ITEMD_CONFIG_VERSION,
  type ConfigurationOptions,
  type ItemDConfiguration,
  resolveConfiguration,
  writeConfiguration,
} from "../config/configuration.ts";
import type { ModelAdapter } from "../model/adapter.ts";
import { PROVIDER_CATALOG } from "../model/catalog.ts";
import type { EnabledProviderDefinition } from "../model/contracts.ts";
import { createModelAdapter } from "../model/factory.ts";
import { getErrorMessage } from "../shared/runtime.ts";
import {
  listTraces,
  replayTrace,
  type ReplayResult,
} from "../telemetry/trace.ts";

const PROMPT = "itemD> ";

export type QuestionOptions = {
  masked?: boolean;
};

export interface TuiIO {
  readonly interrupted: boolean;
  question(
    prompt: string,
    options?: QuestionOptions,
  ): Promise<string | null>;
  write(text: string): void;
  close(): void;
}

class MaskableOutput extends Writable {
  masked = false;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.masked) {
      output.write(chunk);
    }

    callback();
  }
}

export class TerminalTuiIO implements TuiIO {
  interrupted = false;
  private readonly maskedOutput = new MaskableOutput();
  private readonly readline = createInterface({
    input,
    output: this.maskedOutput,
    terminal: true,
  });

  constructor() {
    this.readline.on("SIGINT", () => {
      this.interrupted = true;
      output.write("\n");
      this.readline.close();
    });
  }

  async question(
    prompt: string,
    options: QuestionOptions = {},
  ): Promise<string | null> {
    if (this.interrupted) {
      return null;
    }

    try {
      if (!options.masked) {
        return await this.readline.question(prompt);
      }

      output.write(prompt);
      this.maskedOutput.masked = true;

      try {
        return await this.readline.question("");
      } finally {
        this.maskedOutput.masked = false;

        if (!this.interrupted) {
          output.write("\n");
        }
      }
    } catch (error: unknown) {
      if (this.interrupted) {
        return null;
      }

      throw error;
    }
  }

  write(text: string): void {
    output.write(text);
  }

  close(): void {
    this.readline.close();
  }
}

function writeLine(io: TuiIO, text = ""): void {
  io.write(`${text}\n`);
}

function printHelp(io: TuiIO): void {
  writeLine(io, "Commands:");
  writeLine(io, "  /help               Show this help");
  writeLine(io, "  /config             Show active model setup");
  writeLine(io, "  /setup              Change model setup");
  writeLine(io, "  /replays            List recorded runs");
  writeLine(io, "  /replay <trace-id>  Display a recorded run");
  writeLine(io, "  /clear              Clear the terminal");
  writeLine(io, "  exit()              Exit the interface");
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

async function askForIndex(
  io: TuiIO,
  prompt: string,
  choiceCount: number,
): Promise<number | null> {
  while (true) {
    const answer = await io.question(prompt);

    if (answer === null) {
      return null;
    }

    const index = Number(answer.trim()) - 1;

    if (Number.isInteger(index) && index >= 0 && index < choiceCount) {
      return index;
    }

    writeLine(io, `Choose a number from 1 to ${choiceCount}.`);
  }
}

async function selectProvider(
  io: TuiIO,
): Promise<EnabledProviderDefinition | null> {
  while (true) {
    writeLine(io, "Select a provider:");

    PROVIDER_CATALOG.forEach((provider, index) => {
      const status = provider.enabled
        ? ""
        : ` — ${provider.disabledMessage}`;
      writeLine(io, `  ${index + 1}. ${provider.displayName}${status}`);
    });

    const index = await askForIndex(
      io,
      "Provider: ",
      PROVIDER_CATALOG.length,
    );

    if (index === null) {
      return null;
    }

    const provider = PROVIDER_CATALOG[index];

    if (provider === undefined) {
      continue;
    }

    if (!provider.enabled) {
      writeLine(io, `${provider.displayName}: ${provider.disabledMessage}`);
      writeLine(io);
      continue;
    }

    return provider;
  }
}

export type SetupResult =
  | { status: "saved" }
  | { status: "cancelled" }
  | { status: "failed" };

export async function runSetup(
  io: TuiIO,
  configOptions: ConfigurationOptions = {},
): Promise<SetupResult> {
  writeLine(io, "Model setup");
  writeLine(io);

  const provider = await selectProvider(io);

  if (provider === null) {
    return { status: "cancelled" };
  }

  writeLine(io, "Select a model:");
  provider.models.forEach((model, index) => {
    const suffix = model.id === provider.defaultModel ? " (default)" : "";
    writeLine(io, `  ${index + 1}. ${model.displayName}${suffix}`);
  });
  const modelIndex = await askForIndex(
    io,
    "Model: ",
    provider.models.length,
  );

  if (modelIndex === null) {
    return { status: "cancelled" };
  }

  const model = provider.models[modelIndex];

  if (model === undefined) {
    return { status: "failed" };
  }

  writeLine(io, "Select reasoning effort:");
  provider.reasoningEfforts.forEach((effort, index) => {
    const suffix = effort.id === provider.defaultEffort ? " (default)" : "";
    writeLine(io, `  ${index + 1}. ${effort.displayName}${suffix}`);
  });
  const effortIndex = await askForIndex(
    io,
    "Effort: ",
    provider.reasoningEfforts.length,
  );

  if (effortIndex === null) {
    return { status: "cancelled" };
  }

  const effort = provider.reasoningEfforts[effortIndex];

  if (effort === undefined) {
    return { status: "failed" };
  }

  let apiKey: string;

  while (true) {
    const answer = await io.question("API key: ", { masked: true });

    if (answer === null) {
      return { status: "cancelled" };
    }

    apiKey = answer.trim();

    if (apiKey.length > 0) {
      break;
    }

    writeLine(io, "API key cannot be empty.");
  }

  const configuration: ItemDConfiguration = {
    version: ITEMD_CONFIG_VERSION,
    provider: provider.id,
    model: model.id,
    effort: effort.id,
    apiKey,
  };

  writeLine(io);
  writeLine(io, "Setup summary:");
  writeLine(io, `  provider: ${provider.displayName}`);
  writeLine(io, `  model: ${model.displayName}`);
  writeLine(io, `  effort: ${effort.displayName}`);

  const writeResult = await writeConfiguration(
    configuration,
    configOptions,
  );

  if (!writeResult.ok) {
    writeLine(io, `[configuration error] ${writeResult.error.message}`);
    return { status: "failed" };
  }

  writeLine(io, "Configuration saved.");
  writeLine(io);

  return { status: "saved" };
}

type ActiveConfiguration = {
  configuration: ItemDConfiguration;
  adapter: ModelAdapter;
};

async function resolveActiveConfiguration(
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
  const io = options.io ?? new TerminalTuiIO();
  const workspaceRoot =
    options.workspaceRoot ?? (await realpath(process.cwd()));
  const configOptions = options.config ?? {};

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

      if (command === "/setup") {
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
        writeLine(io, "Type /help for available commands.");
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
