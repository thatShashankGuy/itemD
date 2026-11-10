import { mkdtemp, rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runAgent } from "../src/agent/runner.ts";
import type { ModelAdapter } from "../src/model/adapter.ts";
import type { ModelMessage } from "../src/model/types.ts";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "itemd-agent-session-test-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("agent session history", () => {
  test("starts from restored history and emits new model messages", async () => {
    const workspace = await createWorkspace();
    const restoredHistory: ModelMessage[] = [
      { role: "user", content: "Continue fixing the parser" },
      { role: "assistant", content: "I will inspect the parser." },
    ];
    const observedInputs: ModelMessage[][] = [];
    const emitted: ModelMessage[] = [];
    const adapter: ModelAdapter = {
      metadata: {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
      },
      async call(history) {
        observedInputs.push(
          Array.from(history, (message) => structuredClone(message)),
        );
        return {
          ok: true,
          message: {
            role: "assistant",
            content: "DONE: parser fixed",
          },
          action: { type: "final", text: "DONE: parser fixed" },
        };
      },
    };

    const result = await runAgent(
      "ignored because the caller supplied restored history",
      adapter,
      workspace,
      {
        initialMessages: restoredHistory,
        onMessage: (message) => {
          emitted.push(message);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(observedInputs).toEqual([
      [
        ...restoredHistory,
      ],
    ]);
    expect(emitted).toEqual([
      { role: "assistant", content: "DONE: parser fixed" },
    ]);
  });

  test("emits continuation and tool-result messages in model order", async () => {
    const workspace = await createWorkspace();
    let callCount = 0;
    const emitted: ModelMessage[] = [];
    const adapter: ModelAdapter = {
      metadata: {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
      },
      async call() {
        callCount += 1;

        if (callCount === 1) {
          return {
            ok: true,
            message: {
              role: "assistant",
              content: "I need to inspect the workspace.",
            },
            action: {
              type: "final",
              text: "I need to inspect the workspace.",
            },
          };
        }

        if (callCount === 2) {
          return {
            ok: true,
            message: {
              role: "assistant",
              content: null,
              toolCalls: [
                {
                  id: "call-1",
                  name: "list_files",
                  arguments: "{}",
                },
              ],
            },
            action: {
              type: "tool_calls",
              calls: [
                {
                  id: "call-1",
                  name: "list_files",
                  args: {},
                  call: { type: "list_files" },
                },
              ],
            },
          };
        }

        return {
          ok: true,
          message: {
            role: "assistant",
            content: "DONE: inspected",
          },
          action: { type: "final", text: "DONE: inspected" },
        };
      },
    };

    const result = await runAgent("inspect", adapter, workspace, {
      onMessage: (message) => {
        emitted.push(message);
      },
    });

    expect(result.ok).toBe(true);
    expect(emitted.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(emitted[3]).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
    });
  });
});
