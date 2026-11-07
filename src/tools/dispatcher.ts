import { readFile, writeFile } from "node:fs/promises";
import {
  COMMAND_TIMEOUT_MS,
  executeCommand,
  type CommandResult,
} from "../execution/command.ts";
import { getErrorMessage } from "../shared/runtime.ts";
import {
  type ToolCall,
  type ToolResult,
  validateToolCall,
} from "./contracts.ts";
import { validateShellPolicy } from "../permissions/shell-policy.ts";
import {
  checkRegularFile,
  MAX_FILE_BYTES,
  resolveWorkspaceFile,
} from "../workspace/files.ts";

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
  signal?: AbortSignal,
): Promise<ToolResult<CommandResult>> {
  const policy = validateShellPolicy(call);

  if (!policy.ok) {
    return policy;
  }

  const result = await executeCommand(
    call.executable,
    call.args,
    workspaceRoot,
    COMMAND_TIMEOUT_MS,
    undefined,
    signal,
  );

  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: result.cancelled
          ? "COMMAND_CANCELLED"
          : result.timedOut
            ? "COMMAND_TIMED_OUT"
            : "COMMAND_FAILED",
        message: result.cancelled
          ? "Command cancelled"
          : result.timedOut
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

export async function executeTool(
  input: unknown,
  workspaceRoot: string,
  signal?: AbortSignal,
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
      return executeShell(validation.call, workspaceRoot, signal);
  }
}
