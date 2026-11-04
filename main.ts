import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Command execution

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  cwd: string;
  error?: {
    code: "SPAWN_FAILED";
    message: string;
  };
};

/**
 * Runs a command directly, without a shell, and captures its output and status.
 * Expected process failures are returned as data instead of rejecting the promise.
 */
function executeCommand(
  executable: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    // Prevent the "error" and "close" handlers from resolving more than once.
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;

      resolve({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        cwd,
        error: {
          code: "SPAWN_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;

      resolve({
        ok: exitCode === 0,
        stdout,
        stderr,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        cwd,
      });
    });
  });
}

// Tool contracts and validation

// Tool calls enter the harness as unknown data and must be validated before use.
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
    | "FILE_READ_FAILED"
    | "EDIT_TEXT_NOT_FOUND"
    | "EDIT_TEXT_NOT_UNIQUE"
    | "FILE_EDIT_FAILED"
    | "COMMAND_FAILED";
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

/** Narrows unknown input to an object with string keys. */
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
    case "read_file":
      if (typeof input.path !== "string") {
        return invalidToolCall("read_file.path must be a string");
      }
      return {
        ok: true,
        call: {
          type: "read_file",
          path: input.path,
        },
      };
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

      if (input.oldText.length === 0) {
        return invalidToolCall("edit_file.oldText must not be empty");
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

/** Converts a caught unknown value into a safe error message. */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Tool implementations

async function executeReadFile(
  call: Extract<ToolCall, { type: "read_file" }>,
  cwd: string,
): Promise<ToolResult<string>> {
  try {
    const filePath = resolve(cwd, call.path);
    const content = await readFile(filePath, "utf8");

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
  cwd: string,
): Promise<ToolResult<{ path: string }>> {
  try {
    const filePath = resolve(cwd, call.path);
    const content = await readFile(filePath, "utf8");
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

    await writeFile(filePath, updatedContent, "utf8");
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
  cwd: string,
): Promise<ToolResult<CommandResult>> {
  const result = await executeCommand(
    call.executable,
    call.args,
    cwd,
  );

  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: "COMMAND_FAILED",
        message:
          result.error?.message ||
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

/**
 * Validates one untrusted request and routes it to a tool implementation.
 * Expected validation and execution failures remain structured results.
 */
async function executeTool(
  input: unknown,
  cwd: string,
): Promise<ToolResult> {
  const validation = validateToolCall(input);

  if (!validation.ok) {
    return validation;
  }

  const call = validation.call;

  switch (call.type) {
    case "read_file":
      return executeReadFile(call, cwd);
    case "edit_file":
      return executeEditFile(call, cwd);
    case "shell":
      return executeShell(call, cwd);
  }
}

// Temporary CLI boundary

/**
 * Accepts one JSON tool request. A later model adapter will replace this
 * temporary CLI input while keeping executeTool unchanged.
 */
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
        0,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const result = await executeTool(input, process.cwd());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

await main();
