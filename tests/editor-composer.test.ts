import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  composeWithEditor,
  resolveEditor,
  type EditorProcessExecutor,
} from "../src/ui/editor.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "itemd-editor-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("editor resolution", () => {
  test("prefers VISUAL and parses arguments without shell evaluation", () => {
    expect(
      resolveEditor(
        {
          VISUAL: `code --wait --title "draft; do not run"`,
          EDITOR: "nano",
        },
        "linux",
      ),
    ).toMatchObject({
      ok: true,
      editor: {
        executable: "code",
        args: ["--wait", "--title", "draft; do not run"],
        source: "VISUAL",
      },
    });
  });

  test("uses documented platform fallbacks", () => {
    expect(resolveEditor({}, "linux")).toMatchObject({
      ok: true,
      editor: { executable: "vi", args: [], source: "fallback" },
    });
    expect(resolveEditor({}, "win32")).toMatchObject({
      ok: true,
      editor: { executable: "notepad.exe", args: [], source: "fallback" },
    });
  });

  test("preserves quoted Windows executable paths", () => {
    expect(
      resolveEditor(
        { EDITOR: '"C:\\Program Files\\Editor\\editor.exe" --wait' },
        "win32",
      ),
    ).toMatchObject({
      ok: true,
      editor: {
        executable: "C:\\Program Files\\Editor\\editor.exe",
        args: ["--wait"],
      },
    });
  });

  test("reports malformed configuration instead of falling through", () => {
    expect(
      resolveEditor({ VISUAL: `code "unterminated`, EDITOR: "nano" }, "linux"),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("VISUAL"),
    });
  });
});

describe("editor composition", () => {
  test("loads exact multiline Markdown and removes its private file", async () => {
    const directory = await createTemporaryDirectory();
    let temporaryFile: string | undefined;
    let observedMode: number | undefined;
    const execute: EditorProcessExecutor = async (_executable, args) => {
      temporaryFile = args.at(-1);
      if (temporaryFile === undefined) {
        throw new Error("editor path was not provided");
      }

      observedMode = (await stat(temporaryFile)).mode & 0o777;
      expect(await readFile(temporaryFile, "utf8")).toBe("draft");
      await writeFile(temporaryFile, "# Heading\n\n- one\n- two\n\n", "utf8");
      return { exitCode: 0, signal: null, cancelled: false };
    };

    const result = await composeWithEditor({
      cwd: directory,
      env: { VISUAL: "code --wait" },
      initialContent: "draft",
      tempDirectory: directory,
      execute,
    });

    expect(result).toEqual({
      ok: true,
      content: "# Heading\n\n- one\n- two\n\n",
    });
    expect(observedMode).toBe(0o600);
    expect(temporaryFile).toBeDefined();
    await expect(access(temporaryFile!)).rejects.toThrow();
  });

  test.each([
    ["non-zero exit", { exitCode: 2, signal: null, cancelled: false }, "EDITOR_FAILED"],
    ["cancellation", { exitCode: null, signal: "SIGTERM", cancelled: true }, "EDITOR_CANCELLED"],
  ] as const)("cleans up after %s", async (_label, processResult, code) => {
    const directory = await createTemporaryDirectory();
    let temporaryFile: string | undefined;
    const execute: EditorProcessExecutor = async (_executable, args) => {
      temporaryFile = args.at(-1);
      return processResult;
    };

    const result = await composeWithEditor({
      cwd: directory,
      env: { EDITOR: "nano" },
      tempDirectory: directory,
      execute,
    });

    expect(result).toMatchObject({ ok: false, code });
    expect(temporaryFile).toBeDefined();
    await expect(access(temporaryFile!)).rejects.toThrow();
  });

  test("treats an empty editor file as a recoverable result", async () => {
    const directory = await createTemporaryDirectory();
    const execute: EditorProcessExecutor = async (_executable, args) => {
      const filePath = args.at(-1);
      if (filePath === undefined) {
        throw new Error("editor path was not provided");
      }

      expect(await readFile(filePath, "utf8")).toBe("");
      return { exitCode: 0, signal: null, cancelled: false };
    };

    await expect(
      composeWithEditor({
        cwd: directory,
        env: { EDITOR: "nano" },
        tempDirectory: directory,
        execute,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "EDITOR_EMPTY",
    });
  });

  test("reports a read failure without leaving the temporary directory", async () => {
    const directory = await createTemporaryDirectory();
    let temporaryFile: string | undefined;
    const execute: EditorProcessExecutor = async (_executable, args) => {
      temporaryFile = args.at(-1);
      if (temporaryFile === undefined) {
        throw new Error("editor path was not provided");
      }

      await rm(temporaryFile);
      return { exitCode: 0, signal: null, cancelled: false };
    };

    const result = await composeWithEditor({
      cwd: directory,
      env: { EDITOR: "nano" },
      tempDirectory: directory,
      execute,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "EDITOR_READ_FAILED",
    });
    expect(temporaryFile).toBeDefined();
    await expect(access(temporaryFile!)).rejects.toThrow();
  });
});
