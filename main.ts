import { getErrorMessage } from "./src/shared/runtime.ts";
import {
  runTui,
  type RunTuiOptions,
} from "./src/ui/tui.ts";

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

function printHelp(): void {
  console.log(
    [
      "itemd — interactive OpenTUI coding-agent harness",
      "",
      "Usage:",
      "  itemd             Start the interactive terminal interface",
      "  itemd --help      Show this help",
    ].join("\n"),
  );
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
  } else {
    await runTui().catch((error: unknown) => {
      console.error(`[tui error] ${getErrorMessage(error)}`);
      process.exitCode = 1;
    });
  }
}
