import packageMetadata from "./package.json" with { type: "json" };
import { realpath } from "node:fs/promises";
import { getErrorMessage } from "./src/shared/runtime.ts";
import {
  uninstallStandalone,
  updateStandalone,
} from "./src/cli/lifecycle.ts";
import {
  runTui,
  type RunTuiOptions,
} from "./src/ui/tui.ts";
import { openSessionStore } from "./src/session/store.ts";
import { runWeb } from "./src/ui/web.ts";

export { runTui, type RunTuiOptions } from "./src/ui/tui.ts";
export {
  runAgent,
  type AgentRunResult,
} from "./src/agent/runner.ts";
export { DEFAULT_DEEPSEEK_MODEL } from "./src/model/catalog.ts";
export {
  replayTrace,
  type ReplayResult,
} from "./src/telemetry/trace.ts";
export { runWeb, type WebOptions } from "./src/ui/web.ts";

function printHelp(): void {
  console.log(
    [
      "itemd — interactive coding-agent harness",
      "",
      "Usage:",
      "  itemd             Start the interactive terminal interface",
      "  itemd --web       Start the browser interface",
      "  itemd --sessions  List the 10 most recent sessions",
      "  itemd --resume <session-id>  Resume a saved session",
      "  itemd --auto      Execute approved shell-policy commands without prompts",
      "  itemd --help      Show this help",
      "  itemd --version   Show the installed version",
      "  itemd --update    Update to the latest release",
      "  itemd --uninstall Remove the standalone itemD binary",
    ].join("\n"),
  );
}

function parseTuiOptions(args: string[]): RunTuiOptions | null {
  if (args.length === 0) {
    return null;
  }

  let resumeSessionId: string | undefined;
  let shellMode: RunTuiOptions["shellMode"];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--auto") {
      shellMode = "auto";
      continue;
    }

    if (argument === "--resume" || argument === "resume") {
      const value = args[index + 1];

      if (value === undefined || value.startsWith("-")) {
        return null;
      }

      resumeSessionId = value;
      index += 1;
      continue;
    }

    return null;
  }

  return {
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(shellMode === undefined ? {} : { shellMode }),
  };
}

async function listSessions(): Promise<void> {
  const store = await openSessionStore({ env: process.env });

  try {
    const sessions = store.listSessions(10);

    if (sessions.length === 0) {
      console.log("No saved sessions.");
      return;
    }

    console.log("Recent sessions (newest first):");
    for (const session of sessions) {
      console.log(
        `  ${session.id}  ${session.updatedAt}  ${session.workspaceRoot}`,
      );
    }
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const tuiOptions = parseTuiOptions(args);

  if (args.length === 1 && (command === "--version" || command === "-V")) {
    console.log(`itemD v${packageMetadata.version}`);
  } else if (args.length === 1 && (command === "--help" || command === "-h")) {
    printHelp();
  } else if (args.length === 1 && command === "--update") {
    const result = await updateStandalone();
    console.log(result.ok ? result.message : `[itemD error] ${result.error}`);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } else if (args.length === 1 && command === "--uninstall") {
    const result = await uninstallStandalone();
    console.log(result.ok ? result.message : `[itemD error] ${result.error}`);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } else if (args.length === 1 && command === "--web") {
    try {
      await runWeb({ workspaceRoot: await realpath(process.cwd()) });
    } catch (error: unknown) {
      console.error(`[web error] ${getErrorMessage(error)}`);
      process.exitCode = 1;
    }
  } else if (args.length === 1 && command === "--sessions") {
    await listSessions().catch((error: unknown) => {
      console.error(`[session error] ${getErrorMessage(error)}`);
      process.exitCode = 1;
    });
  } else if (tuiOptions !== null) {
    await runTui(tuiOptions).catch((error: unknown) => {
      console.error(`[tui error] ${getErrorMessage(error)}`);
      process.exitCode = 1;
    });
  } else if (args.length > 0) {
    printHelp();
    process.exitCode = 1;
  } else {
    await runTui().catch((error: unknown) => {
      console.error(`[tui error] ${getErrorMessage(error)}`);
      process.exitCode = 1;
    });
  }
}
