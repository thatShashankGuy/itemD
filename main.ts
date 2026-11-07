import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runAgent,
  type AgentRunResult,
} from "./src/agent/runner.ts";
import {
  DEFAULT_DEEPSEEK_MODEL,
  PROVIDER_CATALOG,
} from "./src/model/catalog.ts";
import { createModelAdapter } from "./src/model/factory.ts";
import { getErrorMessage } from "./src/shared/runtime.ts";
import {
  replayTrace,
  type ReplayResult,
} from "./src/telemetry/trace.ts";

export {
  DEFAULT_DEEPSEEK_MODEL,
  replayTrace,
  runAgent,
  type AgentRunResult,
  type ReplayResult,
};

async function main(): Promise<void> {
  const workspaceRoot = await realpath(process.cwd());
  const cliArgs = process.argv.slice(2);

  if (cliArgs[0] === "--replay") {
    const traceId = cliArgs.length === 2 ? cliArgs[1] : "";
    const result = await replayTrace(
      workspaceRoot,
      traceId ?? "",
    );

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const task = cliArgs.join(" ").trim();

  if (task.length === 0) {
    console.error(
      "Usage: npm start -- 'Describe the coding task'",
    );
    process.exitCode = 1;
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    console.error("DEEPSEEK_API_KEY is missing from .env");
    process.exitCode = 1;
    return;
  }

  const model =
    process.env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL;
  const effort =
    process.env.DEEPSEEK_REASONING_EFFORT ??
    PROVIDER_CATALOG[0].defaultEffort;
  const adapterResult = createModelAdapter({
    provider: "deepseek",
    model,
    effort,
    apiKey,
  });

  if (!adapterResult.ok) {
    console.error(adapterResult.error.message);
    process.exitCode = 1;
    return;
  }

  const result = await runAgent(
    task,
    adapterResult.adapter,
    workspaceRoot,
  );

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isDirectExecution) {
  await main().catch((error: unknown) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: {
            code: "ITEMD_FAILED",
            message: getErrorMessage(error),
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}
