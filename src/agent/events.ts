import type { AgentRunResult } from "./types.ts";
import type { ModelMetadata } from "../model/types.ts";
import type { ToolResult } from "../tools/contracts.ts";

export type RuntimeEventBase = {
  runId: string;
  timestamp: string;
};

export type AgentRuntimeEvent = RuntimeEventBase &
  (
    | {
        type: "run_started";
        task: string;
        metadata: ModelMetadata;
        maxSteps: number;
      }
    | {
        type: "activity";
        phase: "thinking" | "waiting_for_approval" | "executing_tool";
        message: string;
        step?: number;
      }
    | {
        type: "model_delta";
        step: number;
        text: string;
      }
    | {
        type: "tool_started";
        step: number;
        toolCallId: string;
        toolName: string;
      }
    | {
        type: "tool_finished";
        step: number;
        toolCallId: string;
        toolName: string;
        durationMs: number;
        result: ToolResult;
      }
    | {
        type: "run_completed";
        result: Extract<AgentRunResult, { ok: true }>;
      }
    | {
        type: "run_failed";
        result: Extract<AgentRunResult, { ok: false }>;
      }
  );

export type AgentRuntimeEventType = AgentRuntimeEvent["type"];

export type AgentRuntimeEventHandler = (
  event: AgentRuntimeEvent,
) => void | Promise<void>;

export type TerminalRuntimeEvent = Extract<
  AgentRuntimeEvent,
  { type: "run_completed" | "run_failed" }
>;

export function isTerminalRuntimeEvent(
  event: AgentRuntimeEvent,
): event is TerminalRuntimeEvent {
  return event.type === "run_completed" || event.type === "run_failed";
}
