import { spawn } from "node:child_process";
import {
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

// Execution and input limits

const COMMAND_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 1_000;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_FILE_BYTES = 200_000;
const MAX_TOOL_ARGUMENTS = 100;
const MAX_ARGUMENT_CHARS = 4_096;
const MAX_EDIT_TEXT_CHARS = 200_000;

// Command execution

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  cwd: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: {
    code: "SPAWN_FAILED";
    message: string;
  };
};

function appendBounded(
  current: string,
  chunk: unknown,
  limit: number,
): { value: string; truncated: boolean } {
  const text = String(chunk);
  const remaining = limit - current.length;

  if (remaining <= 0) {
    return { value: current, truncated: true };
  }

  if (text.length > remaining) {
    return {
      value: current + text.slice(0, remaining),
      truncated: true,
    };
  }

  return {
    value: current + text,
    truncated: false,
  };
}

/**
 * Runs a command directly, without a shell, and captures a bounded result.
 * Expected process failures resolve as data instead of rejecting the promise.
 */
function executeCommand(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  outputLimit = MAX_OUTPUT_CHARS,
): Promise<CommandResult> {
  const startedAt = Date.now();

  return new Promise<CommandResult>((resolveResult) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");

      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, FORCE_KILL_DELAY_MS);
    }, timeoutMs);

    function clearTimers(): void {
      clearTimeout(timeoutTimer);

      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk, outputLimit);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, outputLimit);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });

    child.on("error", (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();

      resolveResult({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        cwd,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
        error: {
          code: "SPAWN_FAILED",
          message: getErrorMessage(error),
        },
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();

      resolveResult({
        ok: exitCode === 0 && !timedOut,
        stdout,
        stderr,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        cwd,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

// Tool contracts and validation

type ToolCall =
  | {
      type: "read_file";
      path: string;
    }
  | {
      type: "edit_file";
      path: string;
      oldText: string;
      newText: string;
    }
  | {
      type: "shell";
      executable: string;
      args: string[];
    };

type ToolError = {
  code:
    | "INVALID_TOOL_CALL"
    | "EDIT_TEXT_NOT_FOUND"
    | "EDIT_TEXT_NOT_UNIQUE"
    | "FILE_READ_FAILED"
    | "FILE_EDIT_FAILED"
    | "FILE_NOT_REGULAR"
    | "FILE_TOO_LARGE"
    | "COMMAND_FAILED"
    | "COMMAND_DENIED"
    | "COMMAND_TIMED_OUT"
    | "PATH_OUTSIDE_WORKSPACE"
    | "PATH_BLOCKED"
    | "PATH_NOT_FOUND";
  message: string;
  details?: unknown;
};

type ToolResult<T = unknown> =
  | {
      ok: true;
      output: T;
    }
  | {
      ok: false;
      error: ToolError;
    };

type ValidationResult =
  | {
      ok: true;
      call: ToolCall;
    }
  | {
      ok: false;
      error: ToolError;
    };

type WorkspacePathResult =
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      error: ToolError;
    };

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function invalidToolCall(message: string): ValidationResult {
  return {
    ok: false,
    error: {
      code: "INVALID_TOOL_CALL",
      message,
    },
  };
}

/** Converts untrusted input into a typed tool call or a structured error. */
function validateToolCall(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return invalidToolCall("Tool call must be an object");
  }

  if (typeof input.type !== "string") {
    return invalidToolCall("Tool call type must be a string");
  }

  switch (input.type) {
    case "read_file": {
      if (typeof input.path !== "string") {
        return invalidToolCall("read_file.path must be a string");
      }

      if (input.path.trim().length === 0) {
        return invalidToolCall("read_file.path must not be empty");
      }

      return {
        ok: true,
        call: {
          type: "read_file",
          path: input.path,
        },
      };
    }

    case "edit_file": {
      if (
        typeof input.path !== "string" ||
        typeof input.oldText !== "string" ||
        typeof input.newText !== "string"
      ) {
        return invalidToolCall(
          "edit_file requires string path, oldText, and newText",
        );
      }

      if (input.path.trim().length === 0) {
        return invalidToolCall("edit_file.path must not be empty");
      }

      if (input.oldText.length === 0) {
        return invalidToolCall("edit_file.oldText must not be empty");
      }

      if (
        input.oldText.length > MAX_EDIT_TEXT_CHARS ||
        input.newText.length > MAX_EDIT_TEXT_CHARS
      ) {
        return invalidToolCall("Edit text exceeds the allowed size");
      }

      return {
        ok: true,
        call: {
          type: "edit_file",
          path: input.path,
          oldText: input.oldText,
          newText: input.newText,
        },
      };
    }

    case "shell": {
      if (
        typeof input.executable !== "string" ||
        !Array.isArray(input.args) ||
        !input.args.every((argument) => typeof argument === "string")
      ) {
        return invalidToolCall(
          "shell requires an executable string and string[] args",
        );
      }

      if (input.executable.trim().length === 0) {
        return invalidToolCall("shell.executable must not be empty");
      }

      if (input.args.length > MAX_TOOL_ARGUMENTS) {
        return invalidToolCall("shell has too many arguments");
      }

      if (input.args.some((argument) => argument.length > MAX_ARGUMENT_CHARS)) {
        return invalidToolCall("A shell argument exceeds the allowed size");
      }

      return {
        ok: true,
        call: {
          type: "shell",
          executable: input.executable,
          args: input.args,
        },
      };
    }

    default:
      return invalidToolCall(`Unknown tool type: ${input.type}`);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Workspace confinement

function isInsideWorkspace(root: string, target: string): boolean {
  const relativePath = relative(root, target);

  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function isBlockedWorkspacePath(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  const firstPart = relativePath.split(/[\\/]/)[0] ?? "";

  return (
    firstPart === ".git" ||
    firstPart === ".harness" ||
    firstPart === ".env" ||
    firstPart.startsWith(".env.")
  );
}

async function resolveWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<WorkspacePathResult> {
  const candidate = resolve(workspaceRoot, requestedPath);

  if (!isInsideWorkspace(workspaceRoot, candidate)) {
    return {
      ok: false,
      error: {
        code: "PATH_OUTSIDE_WORKSPACE",
        message: "Path resolves outside the workspace",
      },
    };
  }

  if (isBlockedWorkspacePath(workspaceRoot, candidate)) {
    return {
      ok: false,
      error: {
        code: "PATH_BLOCKED",
        message: "Access to this workspace path is blocked",
      },
    };
  }

  let realTarget: string;

  try {
    realTarget = await realpath(candidate);
  } catch {
    return {
      ok: false,
      error: {
        code: "PATH_NOT_FOUND",
        message: "Workspace file does not exist",
      },
    };
  }

  if (!isInsideWorkspace(workspaceRoot, realTarget)) {
    return {
      ok: false,
      error: {
        code: "PATH_OUTSIDE_WORKSPACE",
        message: "Symlink target resolves outside the workspace",
      },
    };
  }

  if (isBlockedWorkspacePath(workspaceRoot, realTarget)) {
    return {
      ok: false,
      error: {
        code: "PATH_BLOCKED",
        message: "Access to this workspace path is blocked",
      },
    };
  }

  return {
    ok: true,
    path: realTarget,
  };
}

async function checkRegularFile(
  filePath: string,
): Promise<ToolResult<{ size: number }>> {
  try {
    const metadata = await stat(filePath);

    if (!metadata.isFile()) {
      return {
        ok: false,
        error: {
          code: "FILE_NOT_REGULAR",
          message: "Path is not a regular file",
        },
      };
    }

    if (metadata.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: {
          code: "FILE_TOO_LARGE",
          message: `File exceeds ${MAX_FILE_BYTES} bytes`,
        },
      };
    }

    return {
      ok: true,
      output: { size: metadata.size },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "FILE_READ_FAILED",
        message: getErrorMessage(error),
      },
    };
  }
}

// Shell policy

type PolicyResult =
  | { ok: true }
  | {
      ok: false;
      error: ToolError;
    };

const ALLOWED_EXECUTABLES = new Set([
  "git",
  "ls",
  "node",
  "npm",
  "pwd",
  "rg",
]);

const READ_ONLY_GIT_COMMANDS = new Set([
  "diff",
  "log",
  "show",
  "status",
]);

function denyCommand(message: string): PolicyResult {
  return {
    ok: false,
    error: {
      code: "COMMAND_DENIED",
      message,
    },
  };
}

function isSensitivePathPart(part: string): boolean {
  return (
    part === ".git" ||
    part === ".harness" ||
    part === ".env" ||
    part.startsWith(".env.")
  );
}

function isUnsafeArgument(argument: string): boolean {
  const normalized = argument.replaceAll("\\", "/");
  // Colons are included so Git object paths such as HEAD:.env are checked too.
  const parts = normalized.split(/[/:]/);

  return (
    argument.includes("\0") ||
    argument.includes("\n") ||
    argument.includes("\r") ||
    isAbsolute(argument) ||
    normalized.startsWith("~") ||
    normalized.includes("=/") ||
    parts.includes("..") ||
    parts.some(isSensitivePathPart)
  );
}

function validateGitCommand(args: string[]): PolicyResult {
  const subcommand = args[0] ?? "";

  if (!READ_ONLY_GIT_COMMANDS.has(subcommand)) {
    return denyCommand("Only read-only Git commands are allowed");
  }

  const forbiddenOptions = [
    "-c",
    "-o",
    "--config-env",
    "--exec-path",
    "--ext-diff",
    "--output",
    "--paginate",
    "--textconv",
  ];

  if (
    args.slice(1).some((argument) =>
      forbiddenOptions.some(
        (option) =>
          argument === option || argument.startsWith(`${option}=`),
      ),
    )
  ) {
    return denyCommand("Git command contains a forbidden option");
  }

  return { ok: true };
}

function validateNodeCommand(args: string[]): PolicyResult {
  const mode = args[0];

  if (mode === "--version" && args.length === 1) {
    return { ok: true };
  }

  if (mode === "--check" && args.length === 2) {
    return { ok: true };
  }

  if (mode === "--test") {
    const writesReporterOutput = args.some(
      (argument) =>
        argument === "--test-reporter-destination" ||
        argument.startsWith("--test-reporter-destination="),
    );

    return writesReporterOutput
      ? denyCommand("Node test output may not be redirected to a file")
      : { ok: true };
  }

  return denyCommand(
    "Node is limited to --version, --check, and --test",
  );
}

function validateNpmCommand(args: string[]): PolicyResult {
  if (args[0] !== "test") {
    return denyCommand("Only npm test is allowed");
  }

  if (args.length > 1 && args[1] !== "--") {
    return denyCommand("npm test options must follow --");
  }

  return { ok: true };
}

function validateRipgrepCommand(args: string[]): PolicyResult {
  const forbiddenOptions = [
    "--hidden",
    "--hostname-bin",
    "--no-ignore",
    "--pre",
    "-u",
    "-uu",
    "-uuu",
  ];

  const bypassesSafety = args.some((argument) =>
    forbiddenOptions.some(
      (option) =>
        argument === option || argument.startsWith(`${option}=`),
    ),
  );

  return bypassesSafety
    ? denyCommand("rg may not execute preprocessors or bypass ignored files")
    : { ok: true };
}

/**
 * Applies a conservative command allowlist before spawning a process.
 * This prevents common accidental host mutations; it is not a sandbox.
 */
function validateShellPolicy(
  call: Extract<ToolCall, { type: "shell" }>,
): PolicyResult {
  if (!ALLOWED_EXECUTABLES.has(call.executable)) {
    return denyCommand(`Executable is not allowed: ${call.executable}`);
  }

  if (call.args.some(isUnsafeArgument)) {
    return denyCommand("Command contains an unsafe argument");
  }

  switch (call.executable) {
    case "pwd":
      return call.args.length === 0
        ? { ok: true }
        : denyCommand("pwd does not accept arguments");

    case "git":
      return validateGitCommand(call.args);

    case "node":
      return validateNodeCommand(call.args);

    case "npm":
      return validateNpmCommand(call.args);

    case "rg":
      return validateRipgrepCommand(call.args);

    case "ls":
      return { ok: true };
  }
}

// Tool implementations

async function executeReadFile(
  call: Extract<ToolCall, { type: "read_file" }>,
  workspaceRoot: string,
): Promise<ToolResult<string>> {
  const resolvedPath = await resolveWorkspaceFile(workspaceRoot, call.path);

  if (!resolvedPath.ok) {
    return resolvedPath;
  }

  const fileCheck = await checkRegularFile(resolvedPath.path);

  if (!fileCheck.ok) {
    return fileCheck;
  }

  try {
    const content = await readFile(resolvedPath.path, "utf8");

    return {
      ok: true,
      output: content,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "FILE_READ_FAILED",
        message: getErrorMessage(error),
      },
    };
  }
}

async function executeEditFile(
  call: Extract<ToolCall, { type: "edit_file" }>,
  workspaceRoot: string,
): Promise<ToolResult<{ path: string }>> {
  const resolvedPath = await resolveWorkspaceFile(workspaceRoot, call.path);

  if (!resolvedPath.ok) {
    return resolvedPath;
  }

  const fileCheck = await checkRegularFile(resolvedPath.path);

  if (!fileCheck.ok) {
    return fileCheck;
  }

  try {
    const content = await readFile(resolvedPath.path, "utf8");
    const firstMatch = content.indexOf(call.oldText);

    if (firstMatch === -1) {
      return {
        ok: false,
        error: {
          code: "EDIT_TEXT_NOT_FOUND",
          message: "oldText was not found in the file",
        },
      };
    }

    const secondMatch = content.indexOf(
      call.oldText,
      firstMatch + call.oldText.length,
    );

    if (secondMatch !== -1) {
      return {
        ok: false,
        error: {
          code: "EDIT_TEXT_NOT_UNIQUE",
          message:
            "oldText occurs more than once; provide more surrounding context",
        },
      };
    }

    const updatedContent =
      content.slice(0, firstMatch) +
      call.newText +
      content.slice(firstMatch + call.oldText.length);

    if (Buffer.byteLength(updatedContent, "utf8") > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: {
          code: "FILE_TOO_LARGE",
          message: `Edited file would exceed ${MAX_FILE_BYTES} bytes`,
        },
      };
    }

    await writeFile(resolvedPath.path, updatedContent, "utf8");

    return {
      ok: true,
      output: {
        path: call.path,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "FILE_EDIT_FAILED",
        message: getErrorMessage(error),
      },
    };
  }
}

async function executeShell(
  call: Extract<ToolCall, { type: "shell" }>,
  workspaceRoot: string,
): Promise<ToolResult<CommandResult>> {
  const policy = validateShellPolicy(call);

  if (!policy.ok) {
    return policy;
  }

  const result = await executeCommand(
    call.executable,
    call.args,
    workspaceRoot,
  );

  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: result.timedOut ? "COMMAND_TIMED_OUT" : "COMMAND_FAILED",
        message: result.timedOut
          ? `Command exceeded ${COMMAND_TIMEOUT_MS}ms`
          : result.error?.message ||
            result.stderr ||
            `Command exited with code ${result.exitCode}`,
        details: result,
      },
    };
  }

  return {
    ok: true,
    output: result,
  };
}

// Tool dispatcher

async function executeTool(
  input: unknown,
  workspaceRoot: string,
): Promise<ToolResult> {
  const validation = validateToolCall(input);

  if (!validation.ok) {
    return validation;
  }

  switch (validation.call.type) {
    case "read_file":
      return executeReadFile(validation.call, workspaceRoot);

    case "edit_file":
      return executeEditFile(validation.call, workspaceRoot);

    case "shell":
      return executeShell(validation.call, workspaceRoot);
  }
}

// Temporary CLI boundary

async function main(): Promise<void> {
  const rawInput = process.argv[2];

  if (!rawInput) {
    console.error("Usage: node main.ts '<tool-call-json>'");
    process.exitCode = 1;
    return;
  }

  let input: unknown;

  try {
    input = JSON.parse(rawInput);
  } catch (error: unknown) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: {
            code: "INVALID_JSON",
            message: getErrorMessage(error),
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const workspaceRoot = await realpath(process.cwd());
  const result = await executeTool(input, workspaceRoot);

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

await main().catch((error: unknown) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          code: "HARNESS_FAILED",
          message: getErrorMessage(error),
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
