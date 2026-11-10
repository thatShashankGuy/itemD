import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { executeTool } from "../src/tools/dispatcher.ts";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "itemd-file-tools-test-")),
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

describe("workspace file tools", () => {
  test("creates, reads, edits, and deletes a file", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "src"));

    await expect(
      executeTool(
        {
          type: "write_file",
          path: "src/example.ts",
          content: "export const answer = 41;\n",
        },
        workspace,
      ),
    ).resolves.toEqual({
      ok: true,
      output: { path: "src/example.ts", bytes: 26, created: true },
    });

    await expect(
      executeTool({ type: "read_file", path: "src/example.ts" }, workspace),
    ).resolves.toEqual({
      ok: true,
      output: "export const answer = 41;\n",
    });

    await expect(
      executeTool(
        {
          type: "edit_file",
          path: "src/example.ts",
          oldText: "answer = 41",
          newText: "answer = 42",
        },
        workspace,
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      readFile(join(workspace, "src/example.ts"), "utf8"),
    ).resolves.toBe("export const answer = 42;\n");

    await expect(
      executeTool(
        { type: "delete_file", path: "src/example.ts" },
        workspace,
      ),
    ).resolves.toEqual({
      ok: true,
      output: { path: "src/example.ts" },
    });

    await expect(
      executeTool({ type: "read_file", path: "src/example.ts" }, workspace),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PATH_NOT_FOUND" },
    });
  });

  test("lists files and searches literal source text", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "src"));
    await writeFile(
      join(workspace, "src", "one.ts"),
      "export function greet(): string {\n  return 'hello';\n}\n",
      "utf8",
    );
    await writeFile(join(workspace, "README.md"), "hello from docs\n", "utf8");
    await writeFile(join(workspace, ".env"), "SECRET=do-not-search\n", "utf8");

    await expect(
      executeTool({ type: "list_files" }, workspace),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        entries: [
          { path: "README.md", type: "file" },
          { path: "src", type: "directory" },
        ],
      },
    });

    await expect(
      executeTool(
        { type: "search_files", query: "hello", path: "src" },
        workspace,
      ),
    ).resolves.toEqual({
      ok: true,
      output: {
        query: "hello",
        matches: [
          { path: "src/one.ts", line: 2, text: "  return 'hello';" },
        ],
        truncated: false,
      },
    });
  });

  test("rejects traversal and symlink escapes for writes and deletes", async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    await writeFile(join(outside, "secret.ts"), "secret", "utf8");

    await expect(
      executeTool(
        { type: "write_file", path: "../outside.ts", content: "unsafe" },
        workspace,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PATH_OUTSIDE_WORKSPACE" },
    });

    if (process.platform !== "win32") {
      await symlink(join(outside, "secret.ts"), join(workspace, "linked.ts"));
      await symlink(
        join(outside, "missing.ts"),
        join(workspace, "dangling.ts"),
      );

      await expect(
        executeTool(
          { type: "write_file", path: "linked.ts", content: "unsafe" },
          workspace,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "PATH_OUTSIDE_WORKSPACE" },
      });

      await expect(
        executeTool({ type: "delete_file", path: "linked.ts" }, workspace),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "PATH_OUTSIDE_WORKSPACE" },
      });

      await expect(
        executeTool(
          { type: "write_file", path: "dangling.ts", content: "unsafe" },
          workspace,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "PATH_OUTSIDE_WORKSPACE" },
      });
    }
  });
});

describe("failure observations", () => {
  test("preserves command diagnostics for the model to explain", async () => {
    const workspace = await createWorkspace();
    const result = await executeTool(
      {
        type: "shell",
        executable: "node",
        args: ["--check", "missing-file.js"],
      },
      workspace,
      undefined,
      { shellMode: "auto" },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "COMMAND_FAILED",
        details: {
          exitCode: 1,
          cwd: workspace,
        },
      },
    });

    if (!result.ok) {
      expect(JSON.stringify(result.error.details)).toContain("missing-file.js");
    }
  });
});
