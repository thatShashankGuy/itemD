import {
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runAgent } from "../src/agent/runner.ts";
import { executeCommand } from "../src/execution/command.ts";
import type { ModelAdapter } from "../src/model/adapter.ts";
import { createModelAdapter } from "../src/model/factory.ts";
import { ShellApprovalController } from "../src/permissions/shell-approval.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryWorkspace(): Promise<string> {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "itemd-cancel-test-")),
  );
  temporaryDirectories.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("agent cancellation", () => {
  test("stops an active model call and records a cancelled run", async () => {
    const workspace = await createTemporaryWorkspace();
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const adapter: ModelAdapter = {
      metadata: {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
      },
      async call(_history, signal) {
        markStarted?.();

        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve({
                ok: false,
                error: {
                  code: "MODEL_REQUEST_FAILED",
                  message: "cancelled",
                },
              });
            },
            { once: true },
          );
        });
      },
    };
    const pending = runAgent("task", adapter, workspace, {
      signal: controller.signal,
    });

    await started;
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      status: "cancelled",
      error: { code: "RUN_CANCELLED" },
    });
    const trace = await readFile(join(workspace, result.tracePath), "utf8");
    expect(trace).toContain('"status":"cancelled"');
  });

  test("passes cancellation to the DeepSeek request", async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchImplementation = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      markStarted?.();

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;
    const factoryResult = createModelAdapter(
      {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
        apiKey: "test-secret",
      },
      { fetchImplementation },
    );

    expect(factoryResult.ok).toBe(true);

    if (!factoryResult.ok) {
      return;
    }

    const pending = factoryResult.adapter.call(
      [{ role: "user", content: "task" }],
      controller.signal,
    );
    await started;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: {
        code: "MODEL_REQUEST_FAILED",
        message: "DeepSeek request cancelled",
      },
    });
  });

  test("cancels a run that is waiting for shell approval", async () => {
    const workspace = await createTemporaryWorkspace();
    const controller = new AbortController();
    let markApprovalStarted: (() => void) | undefined;
    const approvalStarted = new Promise<void>((resolve) => {
      markApprovalStarted = resolve;
    });
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
              id: "call-1",
              name: "shell",
              arguments: "{}",
            }],
          },
          action: {
            type: "tool_calls",
            calls: [{
              id: "call-1",
              name: "shell",
              args: {},
              call: { type: "shell", executable: "pwd", args: [] },
            }],
          },
        };
      },
    };
    const approval = new ShellApprovalController((_request, signal) => {
      markApprovalStarted?.();

      return new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => resolve("deny"),
          { once: true },
        );
      });
    });
    const pending = runAgent("run pwd", adapter, workspace, {
      signal: controller.signal,
      tools: { shellMode: "ask", shellApproval: approval },
    });

    await approvalStarted;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      status: "cancelled",
      error: { code: "RUN_CANCELLED" },
    });
  });

  test("terminates an active command", async () => {
    const workspace = await createTemporaryWorkspace();
    const controller = new AbortController();
    const pending = executeCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      workspace,
      10_000,
      10_000,
      controller.signal,
    );

    setTimeout(() => controller.abort(), 50);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(5_000);
  });
});
