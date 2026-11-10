import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunResult } from "../agent/types.ts";
import type {
  ModelCallResult,
  InteractionMode,
  ModelMessage,
} from "../model/types.ts";
import type {
  ProviderId,
  ReasoningEffort,
} from "../model/contracts.ts";
import { getErrorMessage, isRecord } from "../shared/runtime.ts";
import type { ToolResult } from "../tools/contracts.ts";
import { isInsideWorkspace } from "../workspace/files.ts";

const TRACE_DIRECTORY = ".itemd/traces";
const TRACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type TraceEvent =
  | {
      type: "run_start";
      timestamp: string;
      task: string;
      provider: ProviderId;
      model: string;
      effort: ReasoningEffort;
      mode: InteractionMode;
      maxSteps: number;
    }
  | {
      type: "model_call";
      timestamp: string;
      step: number;
      durationMs: number;
      messages: ModelMessage[];
      result: ModelCallResult;
    }
  | {
      type: "tool_call";
      timestamp: string;
      step: number;
      durationMs: number;
      request: unknown;
      result: ToolResult;
    }
  | {
      type: "activity";
      timestamp: string;
      step: number;
      phase: "waiting_for_approval" | "executing_tool";
      message: string;
    }
  | {
      type: "run_end";
      timestamp: string;
      result: AgentRunResult;
    };

export type TraceWriter = {
  id: string;
  relativePath: string;
  filePath: string;
};

export type ReplayResult =
  | {
      ok: true;
      traceId: string;
      events: unknown[];
    }
  | {
      ok: false;
      error: {
        code:
          | "INVALID_TRACE_ID"
          | "TRACE_READ_FAILED"
          | "TRACE_PARSE_FAILED";
        message: string;
      };
    };

export type TraceListResult =
  | {
      ok: true;
      traces: Array<{
        traceId: string;
        modifiedAt: string;
      }>;
    }
  | {
      ok: false;
      error: {
        code: "TRACE_LIST_FAILED";
        message: string;
      };
    };

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function createTraceWriter(
  workspaceRoot: string,
): Promise<TraceWriter> {
  const id = randomUUID();
  const itemdDirectory = join(workspaceRoot, ".itemd");

  await mkdir(itemdDirectory, { recursive: true });
  const realItemdDirectory = await realpath(itemdDirectory);

  if (!isInsideWorkspace(workspaceRoot, realItemdDirectory)) {
    throw new Error("itemD directory resolves outside the workspace");
  }

  const directory = join(realItemdDirectory, "traces");

  await mkdir(directory, { recursive: true });
  const realDirectory = await realpath(directory);

  if (!isInsideWorkspace(workspaceRoot, realDirectory)) {
    throw new Error("Trace directory resolves outside the workspace");
  }

  return {
    id,
    relativePath: join(TRACE_DIRECTORY, `${id}.jsonl`),
    filePath: join(realDirectory, `${id}.jsonl`),
  };
}

export async function writeTraceEvent(
  writer: TraceWriter,
  event: TraceEvent,
): Promise<void> {
  await appendFile(
    writer.filePath,
    `${JSON.stringify(event)}\n`,
    "utf8",
  );
}

export async function listTraces(
  workspaceRoot: string,
): Promise<TraceListResult> {
  try {
    const traceDirectory = await realpath(
      join(workspaceRoot, TRACE_DIRECTORY),
    );

    if (!isInsideWorkspace(workspaceRoot, traceDirectory)) {
      return {
        ok: false,
        error: {
          code: "TRACE_LIST_FAILED",
          message: "Trace directory resolves outside the workspace",
        },
      };
    }

    const entries = await readdir(traceDirectory, {
      withFileTypes: true,
    });
    const traces = await Promise.all(
      entries.flatMap((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          return [];
        }

        const traceId = entry.name.slice(0, -".jsonl".length);

        if (!TRACE_ID_PATTERN.test(traceId)) {
          return [];
        }

        return [
          stat(join(traceDirectory, entry.name)).then((fileStats) => ({
            traceId,
            modifiedAt: fileStats.mtime.toISOString(),
          })),
        ];
      }),
    );

    traces.sort((left, right) =>
      right.modifiedAt.localeCompare(left.modifiedAt),
    );

    return { ok: true, traces };
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return { ok: true, traces: [] };
    }

    return {
      ok: false,
      error: {
        code: "TRACE_LIST_FAILED",
        message: getErrorMessage(error),
      },
    };
  }
}

export async function replayTrace(
  workspaceRoot: string,
  traceId: string,
): Promise<ReplayResult> {
  if (!TRACE_ID_PATTERN.test(traceId)) {
    return {
      ok: false,
      error: {
        code: "INVALID_TRACE_ID",
        message: "Trace ID must be a UUID generated by itemD",
      },
    };
  }

  try {
    const traceDirectory = await realpath(
      join(workspaceRoot, TRACE_DIRECTORY),
    );

    if (!isInsideWorkspace(workspaceRoot, traceDirectory)) {
      return {
        ok: false,
        error: {
          code: "TRACE_READ_FAILED",
          message: "Trace directory resolves outside the workspace",
        },
      };
    }

    const tracePath = await realpath(
      join(traceDirectory, `${traceId}.jsonl`),
    );

    if (!isInsideWorkspace(traceDirectory, tracePath)) {
      return {
        ok: false,
        error: {
          code: "TRACE_READ_FAILED",
          message: "Trace resolves outside the trace directory",
        },
      };
    }

    const traceStats = await stat(tracePath);

    if (!traceStats.isFile()) {
      return {
        ok: false,
        error: {
          code: "TRACE_READ_FAILED",
          message: "Trace is not a regular file",
        },
      };
    }

    const text = await readFile(tracePath, "utf8");
    const events: unknown[] = [];
    const lines = text.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      if (line === undefined || line.length === 0) {
        continue;
      }

      try {
        events.push(JSON.parse(line) as unknown);
      } catch {
        return {
          ok: false,
          error: {
            code: "TRACE_PARSE_FAILED",
            message: `Trace line ${index + 1} is not valid JSON`,
          },
        };
      }
    }

    return { ok: true, traceId, events };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "TRACE_READ_FAILED",
        message: getErrorMessage(error),
      },
    };
  }
}
