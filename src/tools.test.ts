import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeTool,
  validateToolCall,
  type ToolCall,
} from "./tools.ts";

test("validateToolCall accepts every supported tool", () => {
  const calls: ToolCall[] = [
    { type: "read_file", path: "input.txt" },
    { type: "write_file", path: "output.txt", content: "hello" },
    { type: "list_files" },
    { type: "shell", executable: "node", args: ["--version"] },
  ];

  for (const call of calls) {
    assert.deepEqual(validateToolCall(call), {
      ok: true,
      value: call,
    });
  }
});

test("validateToolCall returns structured errors for invalid input", () => {
  const invalidCalls: unknown[] = [
    null,
    {},
    { type: "unknown" },
    { type: "read_file", path: 42 },
    { type: "write_file", path: "output.txt" },
    { type: "list_files", path: false },
    { type: "shell", executable: "node", args: [42] },
  ];

  for (const call of invalidCalls) {
    const result = validateToolCall(call);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INVALID_TOOL_CALL");
      assert.ok(result.error.message.length > 0);
    }
  }
});

test("executeTool dispatches file and shell tools", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "code-harness-tools-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "input.txt"), "input", "utf8");

  assert.deepEqual(
    await executeTool({ type: "read_file", path: "input.txt" }, workspace),
    { ok: true, output: "input" },
  );

  assert.deepEqual(
    await executeTool(
      { type: "write_file", path: "output.txt", content: "output" },
      workspace,
    ),
    { ok: true, output: "Wrote output.txt" },
  );
  assert.equal(await readFile(join(workspace, "output.txt"), "utf8"), "output");

  const listResult = await executeTool({ type: "list_files" }, workspace);
  assert.equal(listResult.ok, true);
  if (listResult.ok) {
    assert.match(listResult.output, /input\.txt/);
    assert.match(listResult.output, /output\.txt/);
  }

  assert.deepEqual(
    await executeTool(
      {
        type: "shell",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('shell output')"],
      },
      workspace,
    ),
    { ok: true, output: "shell output" },
  );
});

test("executeTool returns structured validation and execution errors", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "code-harness-errors-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));

  const invalidResult = await executeTool(
    { type: "write_file", path: "missing-content.txt" },
    workspace,
  );
  assert.equal(invalidResult.ok, false);
  if (!invalidResult.ok) {
    assert.equal(invalidResult.error.code, "INVALID_TOOL_CALL");
  }

  const missingFileResult = await executeTool(
    { type: "read_file", path: "missing.txt" },
    workspace,
  );
  assert.equal(missingFileResult.ok, false);
  if (!missingFileResult.ok) {
    assert.equal(missingFileResult.error.code, "TOOL_EXECUTION_FAILED");
  }

  const commandResult = await executeTool(
    {
      type: "shell",
      executable: process.execPath,
      args: ["-e", "process.stderr.write('expected failure'); process.exit(2)"],
    },
    workspace,
  );
  assert.deepEqual(commandResult, {
    ok: false,
    error: {
      code: "COMMAND_FAILED",
      message: "expected failure",
    },
  });
});
