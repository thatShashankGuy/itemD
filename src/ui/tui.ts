// #region Imports

import { realpath } from "node:fs/promises";
import {
  stdin as input,
  stdout as output,
} from "node:process";
import { createInterface } from "node:readline/promises";
import {
  runAgent,
  type AgentRunResult,
} from "../agent/runner.ts";
import { DEFAULT_DEEPSEEK_MODEL } from "../model/adapters/deepseek.ts";
import {
  replayTrace,
  type ReplayResult,
} from "../telemetry/trace.ts";

// #endregion

// #region Presentation

const PROMPT = "itemD> ";

function writeLine(text = ""): void {
  output.write(`${text}\n`);
}

function printHelp(): void {
  writeLine("Commands:");
  writeLine("  /help               Show this help");
  writeLine("  /replay <trace-id>  Display a recorded run");
  writeLine("  /clear              Clear the terminal");
  writeLine("  /quit               Exit the interface");
  writeLine();
  writeLine("Any other input starts a new independent agent task.");
}

function printAgentResult(result: AgentRunResult): void {
  writeLine();

  if (result.ok) {
    writeLine(`[done] ${result.answer}`);
  } else {
    writeLine(`[${result.status}] ${result.error.message}`);
  }

  writeLine(`steps: ${result.steps}`);
  writeLine(`trace: ${result.traceId}`);
  writeLine();
}

function printReplayResult(result: ReplayResult): void {
  writeLine(JSON.stringify(result, null, 2));
  writeLine();
}

// #endregion

// #region Commands

async function handleReplay(
  workspaceRoot: string,
  words: string[],
): Promise<void> {
  if (words.length !== 2) {
    writeLine("Usage: /replay <trace-id>");
    writeLine();
    return;
  }

  const traceId = words[1];

  if (traceId === undefined) {
    return;
  }

  const result = await replayTrace(workspaceRoot, traceId);
  printReplayResult(result);
}

// #endregion

// #region TUI loop

async function runTui(): Promise<void> {
  const workspaceRoot = await realpath(process.cwd());
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model =
    process.env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL;
  const readline = createInterface({ input, output });
  let interrupted = false;

  readline.on("SIGINT", () => {
    interrupted = true;
    writeLine();
    readline.close();
  });

  writeLine("itemD — TypeScript Coding Harness");
  writeLine(`workspace: ${workspaceRoot}`);
  writeLine(`model: ${model}`);
  writeLine("Type /help for commands. Each task starts a new run.");
  writeLine();

  try {
    while (!interrupted) {
      let line: string;

      try {
        line = (await readline.question(PROMPT)).trim();
      } catch (error: unknown) {
        if (interrupted) {
          break;
        }

        throw error;
      }

      if (line.length === 0) {
        continue;
      }

      const words = line.split(/\s+/);
      const command = words[0];

      if (command === "/quit" || command === "/exit") {
        break;
      }

      if (command === "/help") {
        printHelp();
        continue;
      }

      if (command === "/clear") {
        output.write("\u001B[2J\u001B[H");
        continue;
      }

      if (command === "/replay") {
        await handleReplay(workspaceRoot, words);
        continue;
      }

      if (command?.startsWith("/")) {
        writeLine(`Unknown command: ${command}`);
        writeLine("Type /help for available commands.");
        writeLine();
        continue;
      }

      if (!apiKey) {
        writeLine("DEEPSEEK_API_KEY is missing from .env");
        writeLine();
        continue;
      }

      writeLine(`Running with ${model}...`);

      try {
        const result = await runAgent(
          line,
          apiKey,
          model,
          workspaceRoot,
        );

        printAgentResult(result);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);

        writeLine(`[itemD error] ${message}`);
        writeLine();
      }
    }
  } finally {
    readline.close();
  }

  writeLine("Goodbye.");
}

await runTui().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);

  console.error(`[tui error] ${message}`);
  process.exitCode = 1;
});

// #endregion
