import type { ModelMessage } from "../model/types.ts";

export type SessionMessagePresentation = {
  label: "you" | "assistant" | "tool";
  text: string;
};

export function presentSessionMessage(
  message: ModelMessage,
): SessionMessagePresentation {
  if (message.role === "user") {
    return { label: "you", text: message.content };
  }

  if (message.role === "tool") {
    return {
      label: "tool",
      text: `${message.toolCallId}: ${message.content}`,
    };
  }

  if (message.content !== null && message.content.length > 0) {
    return { label: "assistant", text: message.content };
  }

  const toolNames = message.toolCalls?.map((call) => call.name).join(", ");

  return {
    label: "assistant",
    text: toolNames === undefined || toolNames.length === 0
      ? "(empty assistant message)"
      : `Requested tools: ${toolNames}`,
  };
}
