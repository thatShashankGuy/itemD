import type {
  ProviderId,
  ReasoningEffort,
} from "./contracts.ts";

export type ModelToolRequest = {
  id: string;
  name: string;
  arguments: string;
};

export type ModelMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning?: string | null;
      toolCalls?: ModelToolRequest[];
    }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolAction = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  call: unknown;
};

export type ModelAction =
  | { type: "tool_calls"; calls: ToolAction[] }
  | { type: "final"; text: string };

export type ModelError = {
  code: "MODEL_REQUEST_FAILED" | "INVALID_MODEL_RESPONSE";
  message: string;
  status?: number;
  details?: unknown;
};

export type ModelCallResult =
  | {
      ok: true;
      action: ModelAction;
      message: Extract<ModelMessage, { role: "assistant" }>;
    }
  | { ok: false; error: ModelError };

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "completed"; result: Extract<ModelCallResult, { ok: true }> }
  | { type: "failed"; error: ModelError };

export type ModelMetadata = {
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
};
