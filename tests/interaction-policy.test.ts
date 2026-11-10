import {
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { selectInteractionMode } from "../src/agent/interaction-policy.ts";
import { runAgent } from "../src/agent/runner.ts";
import type { ModelAdapter } from "../src/model/adapter.ts";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "itemd-interaction-test-"));
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

describe("interaction policy", () => {
  test.each([
    ["What is a closure in JavaScript?", "direct"],
    ["How does DNS work?", "direct"],
    ["Explain recursion", "direct"],
    ["What is Git?", "direct"],
    ["What is in src/index.ts?", "agent"],
    ["Fix the failing tests", "agent"],
    ["How do I run the test suite?", "agent"],
  ])("selects %s as %s", (task, mode) => {
    expect(selectInteractionMode(task)).toBe(mode);
  });

  test("answers an informational question in one direct, no-tool turn", async () => {
    const workspace = await createWorkspace();
    let mode: string | undefined;
    const adapter: ModelAdapter = {
      metadata: {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
      },
      async call(_history, _signal, options) {
        mode = options?.interactionMode;
        return {
          ok: true,
          message: { role: "assistant", content: "A closure captures scope." },
          action: { type: "final", text: "A closure captures scope." },
        };
      },
    };

    const result = await runAgent(
      "What is a closure in JavaScript?",
      adapter,
      workspace,
    );

    expect(result).toMatchObject({
      ok: true,
      answer: "A closure captures scope.",
      steps: 1,
    });
    expect(mode).toBe("direct");

    if (!result.ok) {
      return;
    }

    const trace = await readFile(join(workspace, result.tracePath), "utf8");
    expect(JSON.parse(trace.split("\n")[0] ?? "null")).toMatchObject({
      type: "run_start",
      mode: "direct",
    });
  });

  test("keeps workspace tasks in the tool-enabled agent mode", async () => {
    const workspace = await createWorkspace();
    const modes: string[] = [];
    let calls = 0;
    const adapter: ModelAdapter = {
      metadata: {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
      },
      async call(_history, _signal, options) {
        modes.push(options?.interactionMode ?? "missing");
        calls += 1;

        if (calls === 1) {
          return {
            ok: true,
            message: {
              role: "assistant",
              content: null,
              toolCalls: [{
                id: "list-1",
                name: "list_files",
                arguments: "{}",
              }],
            },
            action: {
              type: "tool_calls",
              calls: [{
                id: "list-1",
                name: "list_files",
                args: {},
                call: { type: "list_files" },
              }],
            },
          };
        }

        return {
          ok: true,
          message: { role: "assistant", content: "DONE: tests fixed" },
          action: { type: "final", text: "DONE: tests fixed" },
        };
      },
    };

    const result = await runAgent("Fix the failing tests", adapter, workspace);

    expect(result).toMatchObject({ ok: true, answer: "tests fixed", steps: 2 });
    expect(modes).toEqual(["agent", "agent"]);
  });

  test("does not execute a tool request that violates direct mode", async () => {
    const workspace = await createWorkspace();
    const adapter: ModelAdapter = {
      metadata: {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
      },
      async call() {
        return {
          ok: true,
          message: {
            role: "assistant",
            content: null,
            toolCalls: [{
              id: "unexpected",
              name: "list_files",
              arguments: "{}",
            }],
          },
          action: {
            type: "tool_calls",
            calls: [{
              id: "unexpected",
              name: "list_files",
              args: {},
              call: { type: "list_files" },
            }],
          },
        };
      },
    };

    await expect(
      runAgent("Explain recursion", adapter, workspace),
    ).resolves.toMatchObject({
      ok: false,
      status: "failed",
      error: { code: "INTERACTION_POLICY_VIOLATION" },
    });
  });
});
