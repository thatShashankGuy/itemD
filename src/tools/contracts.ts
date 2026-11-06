import { isRecord } from "../shared/runtime.ts";

const MAX_TOOL_ARGUMENTS = 100;
const MAX_ARGUMENT_CHARS = 4_096;
const MAX_EDIT_TEXT_CHARS = 200_000;

export type ToolCall =
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

export type ToolError = {
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

export type ToolResult<T = unknown> =
  | {
      ok: true;
      output: T;
    }
  | {
      ok: false;
      error: ToolError;
    };

export type ValidationResult =
  | {
      ok: true;
      call: ToolCall;
    }
  | {
      ok: false;
      error: ToolError;
    };

export type WorkspacePathResult =
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      error: ToolError;
    };

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
export function validateToolCall(input: unknown): ValidationResult {
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
