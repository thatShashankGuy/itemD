// #region Imports

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

// #endregion

// #region Harness configuration

const COMMAND_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 1_000;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_FILE_BYTES = 200_000;
const MAX_TOOL_ARGUMENTS = 100;
const MAX_ARGUMENT_CHARS = 4_096;
const MAX_EDIT_TEXT_CHARS = 200_000;
const MAX_AGENT_STEPS = 50;
const DONE_PREFIX = "DONE:";
const TRACE_DIRECTORY = ".harness/traces";
const TRACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// #endregion

// #region Command execution

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

// #endregion

// #region Tool contracts and validation

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

// #endregion

// #region Workspace confinement

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
          message: "File is not regular",
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

// #endregion

// #region Shell policy

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
  "python",
  "python3",
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

const PYTHON_TEST_MODULES = new Set(["pytest", "unittest"]);

/**
 * Mirrors the Node policy: version checks and test runners only.
 * Arbitrary Python code (`-c`, stdin, scripts, other `-m` modules) stays denied.
 */
function validatePythonCommand(args: string[]): PolicyResult {
  const [mode, ...rest] = args;

  if (mode === "--version" || mode === "-V") {
    return rest.length === 0
      ? { ok: true }
      : denyCommand("Python version flags do not accept arguments");
  }

  if (mode === "-m") {
    const moduleName = rest[0];

    if (moduleName === undefined) {
      return denyCommand("Python -m requires a module name");
    }

    return PYTHON_TEST_MODULES.has(moduleName)
      ? { ok: true }
      : denyCommand(
          "Python modules are limited to pytest and unittest",
        );
  }

  return denyCommand(
    "Python is limited to --version, -m pytest, and -m unittest",
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

    case "python":
    case "python3":
      return validatePythonCommand(call.args);

    case "npm":
      return validateNpmCommand(call.args);

    case "rg":
      return validateRipgrepCommand(call.args);

    case "ls":
      return { ok: true };
  }
}

// #endregion

// #region Tool implementations and dispatcher

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

// #endregion

// #region CLI

async function main(): Promise<void> {
  const workspaceRoot = await realpath(process.cwd());
  const cliArgs = process.argv.slice(2);

  if (cliArgs[0] === "--replay") {
    const traceId = cliArgs.length === 2 ? cliArgs[1] : "";
    const result = await replayTrace(
      workspaceRoot,
      traceId ?? "",
    );

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const task = cliArgs.join(" ").trim();

  if (task.length === 0) {
    console.error(
      "Usage: npm start -- 'Describe the coding task'",
    );
    process.exitCode = 1;
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    console.error("DEEPSEEK_API_KEY is missing from .env");
    process.exitCode = 1;
    return;
  }

  const model =
    process.env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL;

  const result = await runAgent(
    task,
    apiKey,
    model,
    workspaceRoot,
  );

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

// #endregion

// #region Model boundary

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
const MODEL_TIMEOUT_MS = 60_000;
const MAX_MODEL_ERROR_CHARS = 4_000;

const SYSTEM_PROMPT = `
You are the reasoning component of a local coding harness.

The harness, not you, executes tools. You may request multiple tools in one turn.
Use workspace-relative paths only.
Use read_file before editing unfamiliar code.
Use edit_file for one exact replacement.
Use shell only for permitted inspection or test commands.
If a tool fails, inspect the structured error and choose a recovery action.
When the task is complete, respond with DONE: followed by a concise summary.
Do not claim that a tool ran unless its result appears in the conversation.
`.trim();

type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type Message =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

type ToolAction = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  call: unknown;
};

type ModelAction =
  | {
      type: "tool_calls";
      calls: ToolAction[];
    }
  | {
      type: "final";
      text: string;
    };

type ModelError = {
  code: "MODEL_REQUEST_FAILED" | "INVALID_MODEL_RESPONSE";
  message: string;
  status?: number;
  details?: unknown;
};

type ModelCallResult =
  | {
      ok: true;
      action: ModelAction;
      content: Message;
    }
  | {
      ok: false;
      error: ModelError;
    };

function createInitialMessages(task: string): Message[] {
  return [
    {
      role: "user",
      content: task,
    },
  ];
}

const DEEPSEEK_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file inside the current workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace one exact, unique text occurrence in an existing workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
          oldText: {
            type: "string",
            description:
              "Exact text to replace. It must occur exactly once.",
          },
          newText: {
            type: "string",
            description: "Replacement text.",
          },
        },
        required: ["path", "oldText", "newText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run one command allowed by the harness command policy. " +
        "Python is limited to --version, -m pytest, and -m unittest.",
      parameters: {
        type: "object",
        properties: {
          executable: {
            type: "string",
            description:
              "Executable name such as git, node, npm, python3, rg, ls, or pwd.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description:
              "Arguments passed directly without shell interpolation.",
          },
        },
        required: ["executable", "args"],
      },
    },
  },
] as const;

function invalidModelResponse(message: string): ModelCallResult {
  return {
    ok: false,
    error: {
      code: "INVALID_MODEL_RESPONSE",
      message,
    },
  };
}

function getFirstChoiceMessage(
  response: Record<string, unknown>,
): unknown {
  if (!Array.isArray(response.choices)) {
    return undefined;
  }

  const firstChoice = response.choices[0];

  return isRecord(firstChoice)
    ? firstChoice.message
    : undefined;
}

function parseModelResponse(response: unknown): ModelCallResult {
  if (!isRecord(response)) {
    return invalidModelResponse("Model response must be an object");
  }

  const rawMessage = getFirstChoiceMessage(response);

  if (!isRecord(rawMessage)) {
    return invalidModelResponse(
      "Model response has no first choice message",
    );
  }

  if (rawMessage.role !== "assistant") {
    return invalidModelResponse(
      "Model choice message role must be assistant",
    );
  }

  if (
    rawMessage.content !== null &&
    typeof rawMessage.content !== "string"
  ) {
    return invalidModelResponse(
      "Assistant content must be a string or null",
    );
  }

  if (
    rawMessage.reasoning_content !== undefined &&
    rawMessage.reasoning_content !== null &&
    typeof rawMessage.reasoning_content !== "string"
  ) {
    return invalidModelResponse(
      "Assistant reasoning content must be a string or null",
    );
  }

  const rawToolCalls = rawMessage.tool_calls;

  if (
    rawToolCalls !== undefined &&
    !Array.isArray(rawToolCalls)
  ) {
    return invalidModelResponse(
      "Assistant tool calls must be an array",
    );
  }

  const toolCalls: DeepSeekToolCall[] = [];
  const toolActions: ToolAction[] = [];
  const toolCallIds = new Set<string>();

  for (const rawToolCall of rawToolCalls ?? []) {
    if (
      !isRecord(rawToolCall) ||
      typeof rawToolCall.id !== "string" ||
      rawToolCall.id.length === 0 ||
      rawToolCall.type !== "function" ||
      !isRecord(rawToolCall.function) ||
      typeof rawToolCall.function.name !== "string" ||
      typeof rawToolCall.function.arguments !== "string"
    ) {
      return invalidModelResponse(
        "Tool call must contain an id, function name, and JSON arguments",
      );
    }

    if (toolCallIds.has(rawToolCall.id)) {
      return invalidModelResponse(
        "Tool call IDs must be unique within a model turn",
      );
    }

    toolCallIds.add(rawToolCall.id);

    let parsedArguments: unknown;

    try {
      parsedArguments = JSON.parse(
        rawToolCall.function.arguments,
      ) as unknown;
    } catch (error: unknown) {
      return invalidModelResponse(
        `Tool arguments are not valid JSON: ${getErrorMessage(error)}`,
      );
    }

    if (!isRecord(parsedArguments)) {
      return invalidModelResponse(
        "Tool arguments must decode to an object",
      );
    }

    const toolCall: DeepSeekToolCall = {
      id: rawToolCall.id,
      type: "function",
      function: {
        name: rawToolCall.function.name,
        arguments: rawToolCall.function.arguments,
      },
    };
    toolCalls.push(toolCall);
    toolActions.push({
      id: toolCall.id,
      name: toolCall.function.name,
      args: parsedArguments,
      call: {
        ...parsedArguments,
        // Put type last so an argument cannot overwrite the tool name.
        type: toolCall.function.name,
      },
    });
  }

  const content: Message = {
    role: "assistant",
    content: rawMessage.content,
    ...(rawMessage.reasoning_content === undefined
      ? {}
      : { reasoning_content: rawMessage.reasoning_content }),
    ...(rawToolCalls === undefined
      ? {}
      : { tool_calls: toolCalls }),
  };

  if (toolActions.length > 0) {
    return {
      ok: true,
      content,
      action: {
        type: "tool_calls",
        calls: toolActions,
      },
    };
  }

  const text = rawMessage.content?.trim() ?? "";

  if (text.length === 0) {
    return invalidModelResponse(
      "Model response contains neither text nor a function call",
    );
  }

  return {
    ok: true,
    content,
    action: {
      type: "final",
      text,
    },
  };
}

async function callDeepSeek(
  apiKey: string,
  model: string,
  messages: Message[],
): Promise<ModelCallResult> {
  const endpoint = "https://api.deepseek.com/chat/completions";

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, MODEL_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages,
        ],
        tools: DEEPSEEK_TOOLS,
        thinking: { type: "enabled" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();

      return {
        ok: false,
        error: {
          code: "MODEL_REQUEST_FAILED",
          message: `DeepSeek request failed with HTTP ${response.status}`,
          status: response.status,
          details: errorBody.slice(0, MAX_MODEL_ERROR_CHARS),
        },
      };
    }

    let responseBody: unknown;

    try {
      responseBody = await response.json();
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: "INVALID_MODEL_RESPONSE",
          message: `DeepSeek returned invalid JSON: ${getErrorMessage(error)}`,
        },
      };
    }

    return parseModelResponse(responseBody);
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "MODEL_REQUEST_FAILED",
        message:
          error instanceof Error && error.name === "AbortError"
            ? `DeepSeek request exceeded ${MODEL_TIMEOUT_MS}ms`
            : getErrorMessage(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

// #endregion

// #region Tracing and replay

type TraceEvent =
  | {
      type: "run_start";
      timestamp: string;
      task: string;
      model: string;
      maxSteps: number;
    }
  | {
      type: "model_call";
      timestamp: string;
      step: number;
      durationMs: number;
      messages: Message[];
      result: ModelCallResult;
    }
  | {
      type: "tool_call";
      timestamp: string;
      step: number;
      durationMs: number;
      request: unknown;
      result: ToolResult;
    }
  | {
      type: "run_end";
      timestamp: string;
      result: AgentRunResult;
    };

type TraceWriter = {
  id: string;
  relativePath: string;
  filePath: string;
};

export type ReplayResult =
  | {
      ok: true;
      traceId: string;
      events: unknown[];
    }
  | {
      ok: false;
      error: {
        code:
          | "INVALID_TRACE_ID"
          | "TRACE_READ_FAILED"
          | "TRACE_PARSE_FAILED";
        message: string;
      };
    };

async function createTraceWriter(
  workspaceRoot: string,
): Promise<TraceWriter> {
  const id = randomUUID();
  const harnessDirectory = join(workspaceRoot, ".harness");

  await mkdir(harnessDirectory, { recursive: true });
  const realHarnessDirectory = await realpath(harnessDirectory);

  if (!isInsideWorkspace(workspaceRoot, realHarnessDirectory)) {
    throw new Error("Harness directory resolves outside the workspace");
  }

  const directory = join(realHarnessDirectory, "traces");

  await mkdir(directory, { recursive: true });
  const realDirectory = await realpath(directory);

  if (!isInsideWorkspace(workspaceRoot, realDirectory)) {
    throw new Error("Trace directory resolves outside the workspace");
  }

  return {
    id,
    relativePath: join(TRACE_DIRECTORY, `${id}.jsonl`),
    filePath: join(realDirectory, `${id}.jsonl`),
  };
}

async function writeTraceEvent(
  writer: TraceWriter,
  event: TraceEvent,
): Promise<void> {
  await appendFile(
    writer.filePath,
    `${JSON.stringify(event)}\n`,
    "utf8",
  );
}

export async function replayTrace(
  workspaceRoot: string,
  traceId: string,
): Promise<ReplayResult> {
  if (!TRACE_ID_PATTERN.test(traceId)) {
    return {
      ok: false,
      error: {
        code: "INVALID_TRACE_ID",
        message: "Trace ID must be a UUID generated by the harness",
      },
    };
  }

  try {
    const traceDirectory = await realpath(
      join(workspaceRoot, TRACE_DIRECTORY),
    );

    if (!isInsideWorkspace(workspaceRoot, traceDirectory)) {
      return {
        ok: false,
        error: {
          code: "TRACE_READ_FAILED",
          message: "Trace directory resolves outside the workspace",
        },
      };
    }

    const tracePath = await realpath(
      join(traceDirectory, `${traceId}.jsonl`),
    );

    if (!isInsideWorkspace(traceDirectory, tracePath)) {
      return {
        ok: false,
        error: {
          code: "TRACE_READ_FAILED",
          message: "Trace resolves outside the trace directory",
        },
      };
    }

    const traceStats = await stat(tracePath);

    if (!traceStats.isFile()) {
      return {
        ok: false,
        error: {
          code: "TRACE_READ_FAILED",
          message: "Trace is not a regular file",
        },
      };
    }

    const text = await readFile(tracePath, "utf8");
    const events: unknown[] = [];
    const lines = text.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      if (line === undefined || line.length === 0) {
        continue;
      }

      try {
        events.push(JSON.parse(line) as unknown);
      } catch {
        return {
          ok: false,
          error: {
            code: "TRACE_PARSE_FAILED",
            message: `Trace line ${index + 1} is not valid JSON`,
          },
        };
      }
    }

    return { ok: true, traceId, events };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "TRACE_READ_FAILED",
        message: getErrorMessage(error),
      },
    };
  }
}

// #endregion

// #region Agent loop

type AgentError =
  | ModelError
  | {
      code: "MAX_STEPS_REACHED";
      message: string;
    };

export type AgentRunResult =
  | {
      ok: true;
      status: "done";
      answer: string;
      steps: number;
      traceId: string;
      tracePath: string;
    }
  | {
      ok: false;
      status: "failed" | "max_steps";
      steps: number;
      error: AgentError;
      traceId: string;
      tracePath: string;
    };

function getDoneAnswer(text: string): string | undefined {
  const trimmed = text.trim();

  if (!trimmed.startsWith(DONE_PREFIX)) {
    return undefined;
  }

  const answer = trimmed.slice(DONE_PREFIX.length).trim();

  return answer.length > 0 ? answer : undefined;
}

function createToolResultMessage(
  action: ToolAction,
  result: ToolResult,
): Message {
  const response = result.ok
    ? { output: result.output }
    : { error: result.error };

  return {
    role: "tool",
    tool_call_id: action.id,
    content: JSON.stringify(response),
  };
}

function createContinueMessage(): Message {
  return {
    role: "user",
    content:
      "Continue working. Request one tool if more work is needed. " +
      "If the task is complete, reply with DONE: followed by a concise summary.",
  };
}

async function finishAgentRun(
  trace: TraceWriter,
  result: AgentRunResult,
): Promise<AgentRunResult> {
  await writeTraceEvent(trace, {
    type: "run_end",
    timestamp: new Date().toISOString(),
    result,
  });

  return result;
}

export async function runAgent(
  task: string,
  apiKey: string,
  model: string,
  workspaceRoot: string,
  maxSteps = MAX_AGENT_STEPS,
): Promise<AgentRunResult> {
  const messages = createInitialMessages(task);
  const trace = await createTraceWriter(workspaceRoot);

  await writeTraceEvent(trace, {
    type: "run_start",
    timestamp: new Date().toISOString(),
    task,
    model,
    maxSteps,
  });

  for (let step = 1; step <= maxSteps; step += 1) {
    const modelStartedAt = Date.now();
    const modelInput = structuredClone(messages);
    const modelResult = await callDeepSeek(
      apiKey,
      model,
      messages,
    );

    await writeTraceEvent(trace, {
      type: "model_call",
      timestamp: new Date().toISOString(),
      step,
      durationMs: Date.now() - modelStartedAt,
      messages: modelInput,
      result: modelResult,
    });

    if (!modelResult.ok) {
      return finishAgentRun(trace, {
        ok: false,
        status: "failed",
        steps: step,
        error: modelResult.error,
        traceId: trace.id,
        tracePath: trace.relativePath,
      });
    }

    // Preserve call IDs and reasoning content required by DeepSeek history.
    messages.push(modelResult.content);

    if (modelResult.action.type === "final") {
      const answer = getDoneAnswer(modelResult.action.text);

      if (answer !== undefined) {
        return finishAgentRun(trace, {
          ok: true,
          status: "done",
          answer,
          steps: step,
          traceId: trace.id,
          tracePath: trace.relativePath,
        });
      }

      messages.push(createContinueMessage());
      continue;
    }

    for (const action of modelResult.action.calls) {
      const toolStartedAt = Date.now();
      const toolResult = await executeTool(
        action.call,
        workspaceRoot,
      );

      await writeTraceEvent(trace, {
        type: "tool_call",
        timestamp: new Date().toISOString(),
        step,
        durationMs: Date.now() - toolStartedAt,
        request: action.call,
        result: toolResult,
      });

      // Every success or failure must match its DeepSeek tool-call ID.
      messages.push(
        createToolResultMessage(action, toolResult),
      );
    }
  }

  return finishAgentRun(trace, {
    ok: false,
    status: "max_steps",
    steps: maxSteps,
    error: {
      code: "MAX_STEPS_REACHED",
      message: `Agent reached the ${maxSteps}-step limit`,
    },
    traceId: trace.id,
    tracePath: trace.relativePath,
  });
}

// #endregion

// #region Entrypoint

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isDirectExecution) {
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
}

// #endregion
