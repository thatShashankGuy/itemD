import type { AgentRunResult } from "./types.ts";
import type { ModelAdapter } from "../model/adapter.ts";
import type { ModelMessage } from "../model/types.ts";
import {
  createContinueMessage,
  createModelHistory,
  createToolResultMessage,
} from "../model/history.ts";
import {
  executeTool,
  type ToolExecutionOptions,
} from "../tools/dispatcher.ts";
import {
  createTraceWriter,
  type TraceWriter,
  writeTraceEvent,
} from "../telemetry/trace.ts";

const MAX_AGENT_STEPS = 100;
const DONE_PREFIX = "DONE:";

export type { AgentRunResult } from "./types.ts";

export type AgentRunOptions = {
  initialMessages?: readonly ModelMessage[];
  maxSteps?: number;
  onMessage?: (message: ModelMessage) => void | Promise<void>;
  signal?: AbortSignal;
  tools?: ToolExecutionOptions;
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
};

export type AgentRunEvent = {
  type: "reasoning";
  step: number;
  text: string;
};

function getDoneAnswer(text: string): string | undefined {
  const trimmed = text.trim();

  if (!trimmed.startsWith(DONE_PREFIX)) {
    return undefined;
  }

  const answer = trimmed.slice(DONE_PREFIX.length).trim();

  return answer.length > 0 ? answer : undefined;
}

async function finishAgentRun(
  trace: TraceWriter,
  result: AgentRunResult,
): Promise<AgentRunResult> {
  await writeTraceEvent(trace, {
    type: "run_end",
    timestamp: new Date().toISOString(),
    result,
  });

  return result;
}

function finishCancelledRun(
  trace: TraceWriter,
  steps: number,
): Promise<AgentRunResult> {
  return finishAgentRun(trace, {
    ok: false,
    status: "cancelled",
    steps,
    error: {
      code: "RUN_CANCELLED",
      message: "Task stopped by user",
    },
    traceId: trace.id,
    tracePath: trace.relativePath,
  });
}

export async function runAgent(
  task: string,
  adapter: ModelAdapter,
  workspaceRoot: string,
  options: number | AgentRunOptions = {},
): Promise<AgentRunResult> {
  const maxSteps =
    typeof options === "number"
      ? options
      : options.maxSteps ?? MAX_AGENT_STEPS;
  const signal = typeof options === "number" ? undefined : options.signal;
  const toolOptions =
    typeof options === "number" ? {} : options.tools;
  const onEvent = typeof options === "number" ? undefined : options.onEvent;
  const onMessage =
    typeof options === "number" ? undefined : options.onMessage;
  const messages: ModelMessage[] =
    typeof options === "number" || options.initialMessages === undefined
      ? createModelHistory(task)
      : options.initialMessages.map((message) => structuredClone(message));
  const trace = await createTraceWriter(workspaceRoot);

  await writeTraceEvent(trace, {
    type: "run_start",
    timestamp: new Date().toISOString(),
    task,
    ...adapter.metadata,
    maxSteps,
  });

  if (signal?.aborted) {
    return finishCancelledRun(trace, 0);
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    if (signal?.aborted) {
      return finishCancelledRun(trace, step - 1);
    }

    const modelStartedAt = Date.now();
    const modelInput = structuredClone(messages);
    const modelResult = await adapter.call(messages, signal);

    await writeTraceEvent(trace, {
      type: "model_call",
      timestamp: new Date().toISOString(),
      step,
      durationMs: Date.now() - modelStartedAt,
      messages: modelInput,
      result: modelResult,
    });

    if (signal?.aborted) {
      return finishCancelledRun(trace, step);
    }

    if (!modelResult.ok) {
      return finishAgentRun(trace, {
        ok: false,
        status: "failed",
        steps: step,
        error: modelResult.error,
        traceId: trace.id,
        tracePath: trace.relativePath,
      });
    }

    if (
      onEvent !== undefined &&
      typeof modelResult.message.reasoning === "string" &&
      modelResult.message.reasoning.length > 0
    ) {
      await onEvent({
        type: "reasoning",
        step,
        text: modelResult.message.reasoning,
      });
    }

    messages.push(modelResult.message);
    if (onMessage !== undefined) {
      await onMessage(modelResult.message);
    }

    if (modelResult.action.type === "final") {
      const answer = getDoneAnswer(modelResult.action.text);

      if (answer !== undefined) {
        return finishAgentRun(trace, {
          ok: true,
          status: "done",
          answer,
          steps: step,
          traceId: trace.id,
          tracePath: trace.relativePath,
        });
      }

      const continueMessage = createContinueMessage();
      messages.push(continueMessage);
      if (onMessage !== undefined) {
        await onMessage(continueMessage);
      }
      continue;
    }

    for (const action of modelResult.action.calls) {
      if (signal?.aborted) {
        return finishCancelledRun(trace, step);
      }

      const toolStartedAt = Date.now();
      const toolResult = await executeTool(
        action.call,
        workspaceRoot,
        signal,
        toolOptions,
      );

      await writeTraceEvent(trace, {
        type: "tool_call",
        timestamp: new Date().toISOString(),
        step,
        durationMs: Date.now() - toolStartedAt,
        request: action.call,
        result: toolResult,
      });

      if (signal?.aborted) {
        return finishCancelledRun(trace, step);
      }

      const toolMessage = createToolResultMessage(action, toolResult);
      messages.push(toolMessage);
      if (onMessage !== undefined) {
        await onMessage(toolMessage);
      }
    }
  }

  return finishAgentRun(trace, {
    ok: false,
    status: "max_steps",
    steps: maxSteps,
    error: {
      code: "MAX_STEPS_REACHED",
      message: `Agent reached the ${maxSteps}-step limit`,
    },
    traceId: trace.id,
    tracePath: trace.relativePath,
  });
}
