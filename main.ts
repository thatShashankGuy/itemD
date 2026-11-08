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
      "  itemd --help      Show this help",
      "  itemd --version   Show the installed version",
      "  itemd --update    Update to the latest release",
      "  itemd --uninstall Remove the standalone itemD binary",
    ].join("\n"),
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

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
