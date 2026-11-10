import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  executeCommand,
} from "../src/execution/command.ts";
import {
  ShellApprovalController,
} from "../src/permissions/shell-approval.ts";
import { executeTool } from "../src/tools/dispatcher.ts";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "itemd-shell-execution-test-")),
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

describe("model shell execution policy", () => {
  test("requires approval in ask mode", async () => {
    const result = await executeTool(
      { type: "shell", executable: "pwd", args: [] },
      tmpdir(),
      undefined,
      { shellMode: "ask" },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "COMMAND_APPROVAL_REQUIRED" },
    });
  });

  test("supports once and exact-command allowlist decisions", async () => {
    const workspace = await createWorkspace();
    const decisions = ["always", "deny"] as const;
    let requests = 0;
    const approval = new ShellApprovalController(() => {
      const decision = decisions[requests] ?? "deny";
      requests += 1;
      return decision;
    });

    const command = { type: "shell" as const, executable: "pwd", args: [] };
    await expect(
      executeTool(command, workspace, undefined, {
        shellMode: "ask",
        shellApproval: approval,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executeTool(command, workspace, undefined, {
        shellMode: "ask",
        shellApproval: approval,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executeTool(
        { type: "shell", executable: "ls", args: ["-a"] },
        workspace,
        undefined,
        { shellMode: "ask", shellApproval: approval },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "COMMAND_DENIED" },
    });

    expect(requests).toBe(2);
  });

  test("does not remember an approve-once decision", async () => {
    const workspace = await createWorkspace();
    let requests = 0;
    const approval = new ShellApprovalController(() => {
      requests += 1;
      return requests === 1 ? "once" : "deny";
    });
    const command = { type: "shell" as const, executable: "pwd", args: [] };

    await expect(
      executeTool(command, workspace, undefined, {
        shellMode: "ask",
        shellApproval: approval,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executeTool(command, workspace, undefined, {
        shellMode: "ask",
        shellApproval: approval,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "COMMAND_DENIED" },
    });
    expect(requests).toBe(2);
  });

  test("auto mode executes without an approval callback", async () => {
    const workspace = await createWorkspace();
    await expect(
      executeTool(
        { type: "shell", executable: "pwd", args: [] },
        workspace,
        undefined,
        { shellMode: "auto" },
      ),
    ).resolves.toMatchObject({ ok: true, output: { cwd: workspace } });
  });

  test("reports approval and execution activity", async () => {
    const workspace = await createWorkspace();
    const activity: string[] = [];
    const approval = new ShellApprovalController(() => "once");

    await expect(
      executeTool(
        { type: "shell", executable: "pwd", args: [] },
        workspace,
        undefined,
        {
          shellMode: "ask",
          shellApproval: approval,
          onActivity: (event) => {
            activity.push(event.phase);
          },
        },
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(activity).toEqual([
      "waiting_for_approval",
      "executing_tool",
    ]);
  });

  test("cancels a pending approval", async () => {
    const workspace = await createWorkspace();
    const controller = new AbortController();
    const approval = new ShellApprovalController(
      (_request, signal) => new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => resolve("deny"),
          { once: true },
        );
      }),
    );
    const pending = executeTool(
      { type: "shell", executable: "pwd", args: [] },
      workspace,
      controller.signal,
      { shellMode: "ask", shellApproval: approval },
    );

    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "COMMAND_DENIED" },
    });
  });
});

describe("pty command execution", () => {
  test("captures executable output from a pseudoterminal", async () => {
    const workspace = await createWorkspace();
    const result = await executeCommand(
      process.execPath,
      ["--version"],
      workspace,
      5_000,
      10_000,
      undefined,
      true,
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/v\d+/);
    expect(result.stderr).toBe("");
  });
});
