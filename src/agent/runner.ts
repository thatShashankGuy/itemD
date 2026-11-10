import type { AgentRunResult } from "./types.ts";
import type {
  AgentRuntimeEventHandler,
} from "./events.ts";
import type { ModelAdapter } from "../model/adapter.ts";
import type {
  ModelCallResult,
  ModelMessage,
} from "../model/types.ts";
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
import { getErrorMessage } from "../shared/runtime.ts";

const MAX_AGENT_STEPS = 100;
const DONE_PREFIX = "DONE:";

export type { AgentRunResult } from "./types.ts";

export type AgentRunOptions = {
  initialMessages?: readonly ModelMessage[];
  maxSteps?: number;
  onMessage?: (message: ModelMessage) => void | Promise<void>;
  onRuntimeEvent?: AgentRuntimeEventHandler;
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
  onRuntimeEvent?: AgentRuntimeEventHandler,
): Promise<AgentRunResult> {
  await writeTraceEvent(trace, {
    type: "run_end",
    timestamp: new Date().toISOString(),
    result,
  });

  if (onRuntimeEvent !== undefined) {
    if (result.ok) {
      await onRuntimeEvent({
        runId: trace.id,
        timestamp: new Date().toISOString(),
        type: "run_completed",
        result,
      });
    } else {
      await onRuntimeEvent({
        runId: trace.id,
        timestamp: new Date().toISOString(),
        type: "run_failed",
        result,
      });
    }
  }

  return result;
}

function finishCancelledRun(
  trace: TraceWriter,
  steps: number,
  onRuntimeEvent?: AgentRuntimeEventHandler,
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
  }, onRuntimeEvent);
}

async function emitRuntimeEvent(
  onRuntimeEvent: AgentRuntimeEventHandler | undefined,
  event: Parameters<AgentRuntimeEventHandler>[0],
): Promise<void> {
  if (onRuntimeEvent !== undefined) {
    await onRuntimeEvent(event);
  }
}

async function callModel(
  adapter: ModelAdapter,
  messages: readonly ModelMessage[],
  signal: AbortSignal | undefined,
  step: number,
  runId: string,
  onRuntimeEvent: AgentRuntimeEventHandler | undefined,
  onEvent: ((event: AgentRunEvent) => void | Promise<void>) | undefined,
): Promise<{ result: ModelCallResult; streamedReasoning: boolean }> {
  if (adapter.stream === undefined) {
    return {
      result: await adapter.call(messages, signal),
      streamedReasoning: false,
    };
  }

  let result: ModelCallResult | undefined;
  let streamedReasoning = false;

  try {
    for await (const event of adapter.stream(messages, signal)) {
      if (event.type === "text_delta") {
        await emitRuntimeEvent(onRuntimeEvent, {
          runId,
          timestamp: new Date().toISOString(),
          type: "model_delta",
          step,
          text: event.text,
        });
      } else if (event.type === "reasoning_delta") {
        streamedReasoning = true;
        await emitRuntimeEvent(onRuntimeEvent, {
          runId,
          timestamp: new Date().toISOString(),
          type: "activity",
          phase: "thinking",
          message: event.text,
          step,
        });
        if (onEvent !== undefined) {
          await onEvent({ type: "reasoning", step, text: event.text });
        }
      } else if (event.type === "completed") {
        result = event.result;
      } else {
        result = { ok: false, error: event.error };
        break;
      }
    }
  } catch (error: unknown) {
    result = {
      ok: false,
      error: {
        code: "MODEL_REQUEST_FAILED",
        message: getErrorMessage(error),
      },
    };
  }

  return {
    result: result ?? {
      ok: false,
      error: {
        code: "INVALID_MODEL_RESPONSE",
        message: "Model stream ended without a completed result",
      },
    },
    streamedReasoning,
  };
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
  const onRuntimeEvent =
    typeof options === "number" ? undefined : options.onRuntimeEvent;
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

  await emitRuntimeEvent(onRuntimeEvent, {
    runId: trace.id,
    timestamp: new Date().toISOString(),
    type: "run_started",
    task,
    metadata: adapter.metadata,
    maxSteps,
  });

  if (signal?.aborted) {
    return finishCancelledRun(trace, 0, onRuntimeEvent);
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    if (signal?.aborted) {
      return finishCancelledRun(trace, step - 1, onRuntimeEvent);
    }

    const modelStartedAt = Date.now();
    const modelInput = structuredClone(messages);
    const modelCall = await callModel(
      adapter,
      messages,
      signal,
      step,
      trace.id,
      onRuntimeEvent,
      onEvent,
    );
    const modelResult = modelCall.result;

    await writeTraceEvent(trace, {
      type: "model_call",
      timestamp: new Date().toISOString(),
      step,
      durationMs: Date.now() - modelStartedAt,
      messages: modelInput,
      result: modelResult,
    });

    if (signal?.aborted) {
      return finishCancelledRun(trace, step, onRuntimeEvent);
    }

    if (!modelResult.ok) {
      return finishAgentRun(trace, {
        ok: false,
        status: "failed",
        steps: step,
        error: modelResult.error,
        traceId: trace.id,
        tracePath: trace.relativePath,
      }, onRuntimeEvent);
    }

    if (
      onEvent !== undefined &&
      !modelCall.streamedReasoning &&
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
        }, onRuntimeEvent);
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
        return finishCancelledRun(trace, step, onRuntimeEvent);
      }

      const toolStartedAt = Date.now();
      await emitRuntimeEvent(onRuntimeEvent, {
        runId: trace.id,
        timestamp: new Date().toISOString(),
        type: "tool_started",
        step,
        toolCallId: action.id,
        toolName: action.name,
      });
      const executionOptions: ToolExecutionOptions = {
        ...toolOptions,
        onActivity: async (activity) => {
          await emitRuntimeEvent(onRuntimeEvent, {
            runId: trace.id,
            timestamp: new Date().toISOString(),
            type: "activity",
            phase: activity.phase,
            message: activity.message,
            step,
          });
          await toolOptions?.onActivity?.(activity);
        },
      };
      const toolResult = await executeTool(
        action.call,
        workspaceRoot,
        signal,
        executionOptions,
      );

      await writeTraceEvent(trace, {
        type: "tool_call",
        timestamp: new Date().toISOString(),
        step,
        durationMs: Date.now() - toolStartedAt,
        request: action.call,
        result: toolResult,
      });

      await emitRuntimeEvent(onRuntimeEvent, {
        runId: trace.id,
        timestamp: new Date().toISOString(),
        type: "tool_finished",
        step,
        toolCallId: action.id,
        toolName: action.name,
        durationMs: Date.now() - toolStartedAt,
        result: toolResult,
      });

      if (signal?.aborted) {
        return finishCancelledRun(trace, step, onRuntimeEvent);
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
  }, onRuntimeEvent);
}
