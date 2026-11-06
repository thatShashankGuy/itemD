import {
  callDeepSeek,
  createInitialMessages,
  type Message,
  type ToolAction,
} from "../model/adapters/deepseek.ts";
import type { AgentRunResult } from "./types.ts";
import type { ToolResult } from "../tools/contracts.ts";
import { executeTool } from "../tools/dispatcher.ts";
import {
  createTraceWriter,
  type TraceWriter,
  writeTraceEvent,
} from "../telemetry/trace.ts";

const MAX_AGENT_STEPS = 50;
const DONE_PREFIX = "DONE:";

export type { AgentRunResult } from "./types.ts";

function getDoneAnswer(text: string): string | undefined {
  const trimmed = text.trim();

  if (!trimmed.startsWith(DONE_PREFIX)) {
    return undefined;
  }

  const answer = trimmed.slice(DONE_PREFIX.length).trim();

  return answer.length > 0 ? answer : undefined;
}

function createToolResultMessage(
  action: ToolAction,
  result: ToolResult,
): Message {
  const response = result.ok
    ? { output: result.output }
    : { error: result.error };

  return {
    role: "tool",
    tool_call_id: action.id,
    content: JSON.stringify(response),
  };
}

function createContinueMessage(): Message {
  return {
    role: "user",
    content:
      "Continue working. Request one tool if more work is needed. " +
      "If the task is complete, reply with DONE: followed by a concise summary.",
  };
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

export async function runAgent(
  task: string,
  apiKey: string,
  model: string,
  workspaceRoot: string,
  maxSteps = MAX_AGENT_STEPS,
): Promise<AgentRunResult> {
  const messages = createInitialMessages(task);
  const trace = await createTraceWriter(workspaceRoot);

  await writeTraceEvent(trace, {
    type: "run_start",
    timestamp: new Date().toISOString(),
    task,
    model,
    maxSteps,
  });

  for (let step = 1; step <= maxSteps; step += 1) {
    const modelStartedAt = Date.now();
    const modelInput = structuredClone(messages);
    const modelResult = await callDeepSeek(
      apiKey,
      model,
      messages,
    );

    await writeTraceEvent(trace, {
      type: "model_call",
      timestamp: new Date().toISOString(),
      step,
      durationMs: Date.now() - modelStartedAt,
      messages: modelInput,
      result: modelResult,
    });

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

    // Preserve call IDs and reasoning content required by DeepSeek history.
    messages.push(modelResult.content);

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

      messages.push(createContinueMessage());
      continue;
    }

    for (const action of modelResult.action.calls) {
      const toolStartedAt = Date.now();
      const toolResult = await executeTool(
        action.call,
        workspaceRoot,
      );

      await writeTraceEvent(trace, {
        type: "tool_call",
        timestamp: new Date().toISOString(),
        step,
        durationMs: Date.now() - toolStartedAt,
        request: action.call,
        result: toolResult,
      });

      // Every success or failure must match its DeepSeek tool-call ID.
      messages.push(
        createToolResultMessage(action, toolResult),
      );
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
