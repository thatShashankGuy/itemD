import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runAgent } from "../src/agent/runner.ts";
import type { AgentRuntimeEvent } from "../src/agent/events.ts";
import type { ModelAdapter } from "../src/model/adapter.ts";
import { ShellApprovalController } from "../src/permissions/shell-approval.ts";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "itemd-agent-runtime-events-test-")),
  );
  temporaryDirectories.push(workspace);
  return workspace;
}

function metadata(): ModelAdapter["metadata"] {
  return {
    provider: "deepseek",
    model: "deepseek-flash",
    effort: "high",
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("agent runtime event integration", () => {
  test("forwards stream deltas and emits a completed event", async () => {
    const workspace = await createWorkspace();
    const events: AgentRuntimeEvent[] = [];
    const reasoning: string[] = [];
    const adapter: ModelAdapter = {
      metadata: metadata(),
      async *stream() {
        yield { type: "text_delta", text: "DONE: " };
        yield { type: "reasoning_delta", text: "checked" };
        yield {
          type: "completed",
          result: {
            ok: true,
            message: {
              role: "assistant",
              content: "DONE: complete",
              reasoning: "checked",
            },
            action: { type: "final", text: "DONE: complete" },
          },
        };
      },
      async call() {
        throw new Error("call fallback should not be used");
      },
    };

    const result = await runAgent("task", adapter, workspace, {
      onEvent: (event) => {
        reasoning.push(event.text);
      },
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({ ok: true, answer: "complete" });
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "model_delta",
      "activity",
      "run_completed",
    ]);
    expect(events[1]).toMatchObject({ type: "model_delta", text: "DONE: " });
    expect(events[2]).toMatchObject({
      type: "activity",
      phase: "thinking",
      message: "checked",
    });
    expect(reasoning).toEqual(["checked"]);
  });

  test("emits tool lifecycle events for streamed tool calls", async () => {
    const workspace = await createWorkspace();
    const events: AgentRuntimeEvent[] = [];
    let streamCall = 0;
    const adapter: ModelAdapter = {
      metadata: metadata(),
      async call() {
        throw new Error("call fallback should not be used");
      },
      async *stream() {
        streamCall += 1;

        if (streamCall === 1) {
          yield {
            type: "completed",
            result: {
              ok: true,
              message: {
                role: "assistant",
                content: null,
                toolCalls: [{
                  id: "call-1",
                  name: "list_files",
                  arguments: "{}",
                }],
              },
              action: {
                type: "tool_calls",
                calls: [{
                  id: "call-1",
                  name: "list_files",
                  args: {},
                  call: { type: "list_files" },
                }],
              },
            },
          };
          return;
        }

        yield {
          type: "completed",
          result: {
            ok: true,
            message: { role: "assistant", content: "DONE: inspected" },
            action: { type: "final", text: "DONE: inspected" },
          },
        };
      },
    };

    const result = await runAgent("inspect", adapter, workspace, {
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({ ok: true, answer: "inspected" });
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "tool_started",
      "tool_finished",
      "run_completed",
    ]);
    expect(events[2]).toMatchObject({
      type: "tool_finished",
      toolCallId: "call-1",
      result: { ok: true },
    });
  });

  test("turns a streamed model failure into a failed run event", async () => {
    const workspace = await createWorkspace();
    const events: AgentRuntimeEvent[] = [];
    const adapter: ModelAdapter = {
      metadata: metadata(),
      async call() {
        throw new Error("call fallback should not be used");
      },
      async *stream() {
        yield {
          type: "failed",
          error: {
            code: "MODEL_REQUEST_FAILED",
            message: "stream stopped",
          },
        };
      },
    };

    const result = await runAgent("task", adapter, workspace, {
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { message: "stream stopped" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "run_failed",
    ]);
  });

  test("forwards shell approval and execution activity", async () => {
    const workspace = await createWorkspace();
    const events: AgentRuntimeEvent[] = [];
    let streamCall = 0;
    const adapter: ModelAdapter = {
      metadata: metadata(),
      async call() {
        throw new Error("call fallback should not be used");
      },
      async *stream() {
        streamCall += 1;

        if (streamCall === 1) {
          yield {
            type: "completed",
            result: {
              ok: true,
              message: {
                role: "assistant",
                content: null,
                toolCalls: [{
                  id: "call-pwd",
                  name: "shell",
                  arguments: '{"type":"shell","executable":"pwd","args":[]}',
                }],
              },
              action: {
                type: "tool_calls",
                calls: [{
                  id: "call-pwd",
                  name: "shell",
                  args: {},
                  call: { type: "shell", executable: "pwd", args: [] },
                }],
              },
            },
          };
          return;
        }

        yield {
          type: "completed",
          result: {
            ok: true,
            message: { role: "assistant", content: "DONE: approved" },
            action: { type: "final", text: "DONE: approved" },
          },
        };
      },
    };

    const result = await runAgent("run pwd", adapter, workspace, {
      tools: {
        shellMode: "ask",
        shellApproval: new ShellApprovalController(() => "once"),
      },
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({ ok: true, answer: "approved" });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "activity",
          phase: "waiting_for_approval",
        }),
        expect.objectContaining({
          type: "activity",
          phase: "executing_tool",
        }),
      ]),
    );

    const trace = await readFile(join(workspace, result.tracePath), "utf8");
    expect(trace).toContain('"type":"activity"');
    expect(trace).toContain('"phase":"waiting_for_approval"');
    expect(trace).not.toContain('"type":"model_delta"');
  });
});
