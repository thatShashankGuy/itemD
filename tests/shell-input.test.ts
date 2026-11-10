import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  executePrefixedShellCommand,
  formatShellResult,
} from "../src/ui/shell.ts";
import { parseShellInput } from "../src/execution/shell-input.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("direct shell input", () => {
  test("parses quoted and escaped arguments without shell evaluation", () => {
    expect(
      parseShellInput(`git log --format="%h %s" 'one two' three\\ four`),
    ).toEqual({
      ok: true,
      executable: "git",
      args: ["log", "--format=%h %s", "one two", "three four"],
    });

    expect(parseShellInput("npm test && echo not-run")).toEqual({
      ok: true,
      executable: "npm",
      args: ["test", "&&", "echo", "not-run"],
    });
  });

  test.each(["", "git status '", "git status \\"]) (
    "rejects malformed command input %s",
    (input) => {
      expect(parseShellInput(input)).toMatchObject({ ok: false });
    },
  );

  test("executes an allowed command in the workspace", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "itemd-shell-input-test-")),
    );
    temporaryDirectories.push(directory);

    const result = await executePrefixedShellCommand("pwd", directory);

    expect(result).toMatchObject({
      ok: true,
      output: { ok: true, cwd: directory },
    });
    expect(formatShellResult("pwd", result)).toContain(directory);
  });

  test("executes cat for a workspace file", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "itemd-shell-cat-test-")),
    );
    temporaryDirectories.push(directory);
    const filePath = join(directory, "message.txt");
    await writeFile(filePath, "hello from cat\n");

    const result = await executePrefixedShellCommand("cat message.txt", directory);

    expect(result).toMatchObject({
      ok: true,
      output: { stdout: "hello from cat\n", exitCode: 0 },
    });
  });

  test("does not allow cat to wait for stdin", async () => {
    const result = await executePrefixedShellCommand("cat", tmpdir());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "COMMAND_DENIED",
        message: "cat requires at least one file path",
      },
    });
  });

  test("routes disallowed commands through the shell policy", async () => {
    const result = await executePrefixedShellCommand("echo unsafe", tmpdir());

    expect(result).toEqual({
      ok: false,
      error: {
        code: "COMMAND_DENIED",
        message: "Executable is not allowed: echo",
      },
    });
    expect(formatShellResult("echo unsafe", result)).toContain(
      "[shell error] Executable is not allowed: echo",
    );
  });
});
