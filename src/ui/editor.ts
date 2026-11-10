import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseShellInput,
  type ShellInputResult,
} from "../execution/shell-input.ts";

export type EditorDefinition = {
  executable: string;
  args: string[];
  source: "VISUAL" | "EDITOR" | "fallback";
};

export type EditorProcessResult = {
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  error?: {
    message: string;
  };
};

export type EditorProcessExecutor = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
) => Promise<EditorProcessResult>;

export type EditorComposerOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  initialContent?: string;
  signal?: AbortSignal;
  tempDirectory?: string;
  execute?: EditorProcessExecutor;
  platform?: NodeJS.Platform;
};

export type EditorComposerResult =
  | {
      ok: true;
      content: string;
    }
  | {
      ok: false;
      code:
        | "EDITOR_INVALID"
        | "EDITOR_CANCELLED"
        | "EDITOR_FAILED"
        | "EDITOR_EMPTY"
        | "EDITOR_TEMPORARY_FILE"
        | "EDITOR_READ_FAILED"
        | "EDITOR_CLEANUP_FAILED";
      message: string;
    };

function configuredEditor(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { value: string; source: EditorDefinition["source"] } {
  const visual = env.VISUAL?.trim();

  if (visual !== undefined && visual.length > 0) {
    return { value: visual, source: "VISUAL" };
  }

  const editor = env.EDITOR?.trim();

  if (editor !== undefined && editor.length > 0) {
    return { value: editor, source: "EDITOR" };
  }

  return {
    value: platform === "win32" ? "notepad.exe" : "vi",
    source: "fallback",
  };
}

function parseWindowsEditorInput(input: string): ShellInputResult {
  const value = input.trim();
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character === undefined) {
      continue;
    }

    if (quote !== null) {
      const quoteCharacter = quote === "single" ? "'" : '"';

      if (character === quoteCharacter) {
        quote = null;
      } else if (
        character === "\\" &&
        value[index + 1] === quoteCharacter
      ) {
        token += quoteCharacter;
        tokenStarted = true;
        index += 1;
      } else {
        token += character;
        tokenStarted = true;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else if (character === "\\" && value[index + 1] === '"') {
      token += '"';
      tokenStarted = true;
      index += 1;
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote !== null) {
    return { ok: false, message: "Shell command has an unterminated quote" };
  }

  if (tokenStarted) {
    tokens.push(token);
  }

  const executable = tokens[0];

  if (executable === undefined || executable.length === 0) {
    return { ok: false, message: "Usage: !<command> [args...]" };
  }

  return {
    ok: true,
    executable,
    args: tokens.slice(1),
  };
}

export function resolveEditor(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
):
  | { ok: true; editor: EditorDefinition }
  | { ok: false; message: string } {
  const configured = configuredEditor(env, platform);
  const parsed = platform === "win32"
    ? parseWindowsEditorInput(configured.value)
    : parseShellInput(configured.value);

  if (!parsed.ok) {
    return {
      ok: false,
      message: `The ${configured.source} editor setting is invalid: ${parsed.message}`,
    };
  }

  return {
    ok: true,
    editor: {
      executable: parsed.executable,
      args: parsed.args,
      source: configured.source,
    },
  };
}

function executeEditorProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<EditorProcessResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      cancelled: true,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let cancelled = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "inherit",
    });

    const finish = (result: EditorProcessResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = (): void => {
      cancelled = true;
      child.kill();
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", () => {
      finish({
        exitCode: null,
        signal: null,
        cancelled,
        error: { message: "The configured editor could not be started." },
      });
    });
    child.once("exit", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        cancelled,
      });
    });

    if (options.signal?.aborted) {
      onAbort();
    }
  });
}

async function removeTemporaryDirectory(directory: string): Promise<boolean> {
  try {
    await rm(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function composeWithEditor(
  options: EditorComposerOptions,
): Promise<EditorComposerResult> {
  const env = options.env ?? process.env;
  const resolved = resolveEditor(env, options.platform);

  if (!resolved.ok) {
    return {
      ok: false,
      code: "EDITOR_INVALID",
      message: resolved.message,
    };
  }

  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "EDITOR_CANCELLED",
      message: "Editor composition cancelled.",
    };
  }

  let temporaryDirectory: string | undefined;
  let result: EditorComposerResult | undefined;

  try {
    temporaryDirectory = await mkdtemp(
      join(options.tempDirectory ?? tmpdir(), "itemd-editor-"),
    );
    await chmod(temporaryDirectory, 0o700);

    const filePath = join(temporaryDirectory, "message.md");
    const file = await open(filePath, "wx", 0o600);

    try {
      await file.writeFile(options.initialContent ?? "", "utf8");
    } finally {
      await file.close();
    }

    await chmod(filePath, 0o600);
    const execute = options.execute ?? executeEditorProcess;
    const processResult = await execute(
      resolved.editor.executable,
      [...resolved.editor.args, filePath],
      {
        cwd: options.cwd,
        env,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );

    if (processResult.cancelled || options.signal?.aborted) {
      result = {
        ok: false,
        code: "EDITOR_CANCELLED",
        message: "Editor composition cancelled.",
      };
    } else if (processResult.error !== undefined || processResult.exitCode !== 0) {
      result = {
        ok: false,
        code: "EDITOR_FAILED",
        message: processResult.error?.message ?? "The editor exited without saving the message.",
      };
    } else {
      let content: string | undefined;

      try {
        content = await readFile(filePath, "utf8");
      } catch {
        result = {
          ok: false,
          code: "EDITOR_READ_FAILED",
          message: "The editor message could not be read.",
        };
      }

      if (content !== undefined) {
        result = content.length === 0
          ? {
              ok: false,
              code: "EDITOR_EMPTY",
              message: "The editor returned an empty message. The composer is unchanged.",
            }
          : { ok: true, content };
      }
    }
  } catch {
    result = {
      ok: false,
      code: "EDITOR_TEMPORARY_FILE",
      message: "The editor temporary file could not be prepared.",
    };
  }

  if (temporaryDirectory !== undefined) {
    const cleaned = await removeTemporaryDirectory(temporaryDirectory);

    if (!cleaned) {
      return {
        ok: false,
        code: "EDITOR_CLEANUP_FAILED",
        message: "The editor temporary file could not be removed.",
      };
    }
  }

  return result ?? {
    ok: false,
    code: "EDITOR_TEMPORARY_FILE",
    message: "The editor temporary file could not be prepared.",
  };
}
