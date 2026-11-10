import { describe, expect, test } from "vitest";
import {
  isTerminalRuntimeEvent,
  type AgentRuntimeEvent,
} from "../src/agent/events.ts";

const base = {
  runId: "run-1",
  timestamp: "2026-11-10T00:00:00.000Z",
};

describe("agent runtime event contract", () => {
  test("distinguishes activity, model, tool, and terminal events", () => {
    const events: AgentRuntimeEvent[] = [
      {
        ...base,
        type: "run_started",
        task: "fix tests",
        metadata: {
          provider: "deepseek",
          model: "deepseek-flash",
          effort: "high",
        },
        maxSteps: 100,
      },
      {
        ...base,
        type: "activity",
        phase: "thinking",
        message: "Inspecting the failure",
        step: 1,
      },
      { ...base, type: "model_delta", step: 1, text: "The build " },
      {
        ...base,
        type: "tool_started",
        step: 1,
        toolCallId: "call-1",
        toolName: "list_files",
      },
      {
        ...base,
        type: "tool_finished",
        step: 1,
        toolCallId: "call-1",
        toolName: "list_files",
        durationMs: 4,
        result: { ok: true, output: "README.md" },
      },
      {
        ...base,
        type: "run_completed",
        result: {
          ok: true,
          status: "done",
          answer: "Tests pass",
          steps: 1,
          traceId: "trace-1",
          tracePath: ".itemd/traces/trace-1.jsonl",
        },
      },
    ];

    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "activity",
      "model_delta",
      "tool_started",
      "tool_finished",
      "run_completed",
    ]);
    expect(isTerminalRuntimeEvent(events[0]!)).toBe(false);
    expect(isTerminalRuntimeEvent(events[5]!)).toBe(true);
  });

  test("identifies failed runs as terminal events", () => {
    const event: AgentRuntimeEvent = {
      ...base,
      type: "run_failed",
      result: {
        ok: false,
        status: "failed",
        steps: 2,
        error: {
          code: "MODEL_REQUEST_FAILED",
          message: "Provider request failed",
        },
        traceId: "trace-2",
        tracePath: ".itemd/traces/trace-2.jsonl",
      },
    };

    expect(isTerminalRuntimeEvent(event)).toBe(true);
  });
});
