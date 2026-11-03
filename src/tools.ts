import {
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { executeCommand } from "./shell.ts";

export type ToolCall =
  {
    type: "read_file";
    path: string;
  } | {
    type: "write_file";
    path: string;
    content: string;
  } | {
    type: "list_files";
    path?: string;
  } | {
    type: "shell";
    executable: string;
    args: string[];
  };

export type ToolError = {
  code:
    | "INVALID_TOOL_CALL"
    | "COMMAND_FAILED"
    | "TOOL_EXECUTION_FAILED";
  message: string;
};

export type ToolResult =
  | {
      ok: true;
      output: string;
    }
  | {
      ok: false;
      error: ToolError;
    };

export type ToolCallValidationResult =
  | { ok: true; value: ToolCall }
  | {
      ok: false;
      error: ToolError & { code: "INVALID_TOOL_CALL" };
    };

export function validateToolCall(
  input: unknown,
): ToolCallValidationResult {
  if (!isRecord(input)) {
    return invalidToolCall("Tool call must be an object");
  }

  if (typeof input.type !== "string") {
    return invalidToolCall("'type' must be a string");
  }

  switch (input.type) {
    case "read_file":
      if (typeof input.path !== "string") {
        return invalidToolCall("'read_file.path' must be a string");
      }

      return {
        ok: true,
        value: { type: "read_file", path: input.path },
      };

    case "write_file":
      if (
        typeof input.path !== "string" ||
        typeof input.content !== "string"
      ) {
        return invalidToolCall(
          "'write_file.path' and 'write_file.content' must be strings",
        );
      }

      return {
        ok: true,
        value: {
          type: "write_file",
          path: input.path,
          content: input.content,
        },
      };

    case "list_files":
      if (
        input.path !== undefined &&
        typeof input.path !== "string"
      ) {
        return invalidToolCall(
          "'list_files.path' must be a string when provided",
        );
      }

      return {
        ok: true,
        value: {
          type: "list_files",
          ...(input.path === undefined ? {} : { path: input.path }),
        },
      };

    case "shell":
      if (
        typeof input.executable !== "string" ||
        !Array.isArray(input.args) ||
        !input.args.every((argument) => typeof argument === "string")
      ) {
        return invalidToolCall(
          "'shell.executable' must be a string and 'shell.args' must be an array of strings",
        );
      }

      return {
        ok: true,
        value: {
          type: "shell",
          executable: input.executable,
          args: input.args,
        },
      };

    default:
      return invalidToolCall(`Unknown tool type: ${input.type}`);
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function invalidToolCall(message: string): ToolCallValidationResult {
  return {
    ok: false,
    error: {
      code: "INVALID_TOOL_CALL",
      message,
    },
  };
}


export async function executeTool(
  input: unknown,
  cwd: string,
): Promise<ToolResult> {
  const validation = validateToolCall(input);

  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
    };
  }

  const call = validation.value;

  try {
    switch (call.type) {
      case "list_files": {
        const directoryPath = resolve(cwd, call.path ?? ".");
        const entries = await readdir(directoryPath, {
          withFileTypes: true,
        });
        const output = entries
          .map((entry) => {
            return entry.isDirectory() ? `${entry.name}/` : entry.name;
          })
          .join("\n");

        return {
          ok: true,
          output,
        };
      }

      case "read_file": {
        const filePath = resolve(cwd, call.path);
        const content = await readFile(filePath, "utf8");

        return {
          ok: true,
          output: content,
        };
      }

      case "write_file": {
        const filePath = resolve(cwd, call.path);
        await writeFile(filePath, call.content, "utf8");

        return {
          ok: true,
          output: `Wrote ${call.path}`,
        };
      }

      case "shell": {
        const result = await executeCommand(
          call.executable,
          call.args,
          cwd,
        );

        if (result.exitCode !== 0) {
          return {
            ok: false,
            error: {
              code: "COMMAND_FAILED",
              message:
                result.stderr ||
                result.stdout ||
                `Command exited with code ${result.exitCode}`,
            },
          };
        }

        return {
          ok: true,
          output: result.stdout,
        };
      }

      default:
        return {
          ok: false,
          error: {
            code: "INVALID_TOOL_CALL",
            message: "Unknown tool type",
          },
        };
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "TOOL_EXECUTION_FAILED",
        message: getErrorMessage(error),
      },
    };
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
