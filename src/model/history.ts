import type { ToolResult } from "../tools/contracts.ts";
import type { ModelMessage, ToolAction } from "./types.ts";

export function createModelHistory(task: string): ModelMessage[] {
  return [{ role: "user", content: task }];
}

export function createToolResultMessage(
  action: ToolAction,
  result: ToolResult,
): ModelMessage {
  const response = result.ok
    ? { output: result.output }
    : { error: result.error };

  return {
    role: "tool",
    toolCallId: action.id,
    content: JSON.stringify(response),
  };
}

export function createContinueMessage(): ModelMessage {
  return {
    role: "user",
    content:
      "Continue working. Request tools if more work is needed. " +
      "If the task is complete, reply with DONE: followed by a concise summary",
  };
}
