import { isRecord } from "../shared/runtime.ts";
import { validateWebFetchUrl } from "../permissions/web-policy.ts";

const MAX_TOOL_ARGUMENTS = 100;
const MAX_ARGUMENT_CHARS = 4_096;
const MAX_EDIT_TEXT_CHARS = 200_000;
const MAX_SEARCH_QUERY_CHARS = 500;

export type ToolCall =
  | {
      type: "read_file";
      path: string;
    }
  | {
      type: "write_file";
      path: string;
      content: string;
    }
  | {
      type: "edit_file";
      path: string;
      oldText: string;
      newText: string;
    }
  | {
      type: "delete_file";
      path: string;
    }
  | {
      type: "list_files";
      path?: string;
    }
  | {
      type: "search_files";
      query: string;
      path?: string;
    }
  | {
      type: "shell";
      executable: string;
      args: string[];
    }
  | {
      type: "web_search";
      query: string;
    }
  | {
      type: "web_fetch";
      url: string;
    };

export type ToolError = {
  code:
    | "INVALID_TOOL_CALL"
    | "EDIT_TEXT_NOT_FOUND"
    | "EDIT_TEXT_NOT_UNIQUE"
    | "FILE_READ_FAILED"
    | "FILE_WRITE_FAILED"
    | "FILE_EDIT_FAILED"
    | "FILE_DELETE_FAILED"
    | "FILE_NOT_REGULAR"
    | "FILE_TOO_LARGE"
    | "DIRECTORY_READ_FAILED"
    | "SEARCH_FAILED"
    | "COMMAND_FAILED"
    | "COMMAND_DENIED"
    | "COMMAND_CANCELLED"
    | "COMMAND_TIMED_OUT"
    | "WEB_SEARCH_DISABLED"
    | "WEB_SEARCH_FAILED"
    | "WEB_FETCH_FAILED"
    | "WEB_FETCH_URL_INVALID"
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

    case "write_file": {
      if (typeof input.path !== "string" || typeof input.content !== "string") {
        return invalidToolCall(
          "write_file requires string path and content",
        );
      }

      if (input.path.trim().length === 0) {
        return invalidToolCall("write_file.path must not be empty");
      }

      if (input.content.length > MAX_EDIT_TEXT_CHARS) {
        return invalidToolCall("write_file.content exceeds the allowed size");
      }

      return {
        ok: true,
        call: {
          type: "write_file",
          path: input.path,
          content: input.content,
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

    case "delete_file": {
      if (typeof input.path !== "string") {
        return invalidToolCall("delete_file.path must be a string");
      }

      if (input.path.trim().length === 0) {
        return invalidToolCall("delete_file.path must not be empty");
      }

      return {
        ok: true,
        call: {
          type: "delete_file",
          path: input.path,
        },
      };
    }

    case "list_files": {
      if (input.path !== undefined && typeof input.path !== "string") {
        return invalidToolCall("list_files.path must be a string when provided");
      }

      if (typeof input.path === "string" && input.path.trim().length === 0) {
        return invalidToolCall("list_files.path must not be empty");
      }

      return {
        ok: true,
        call: {
          type: "list_files",
          ...(input.path === undefined ? {} : { path: input.path }),
        },
      };
    }

    case "search_files": {
      if (typeof input.query !== "string") {
        return invalidToolCall("search_files.query must be a string");
      }

      if (
        input.query.trim().length < 1 ||
        input.query.length > MAX_SEARCH_QUERY_CHARS
      ) {
        return invalidToolCall(
          `search_files.query must be between 1 and ${MAX_SEARCH_QUERY_CHARS} characters`,
        );
      }

      if (input.path !== undefined && typeof input.path !== "string") {
        return invalidToolCall("search_files.path must be a string when provided");
      }

      if (typeof input.path === "string" && input.path.trim().length === 0) {
        return invalidToolCall("search_files.path must not be empty");
      }

      return {
        ok: true,
        call: {
          type: "search_files",
          query: input.query,
          ...(input.path === undefined ? {} : { path: input.path }),
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

    case "web_search": {
      if (typeof input.query !== "string") {
        return invalidToolCall("web_search.query must be a string");
      }

      if (input.query.trim().length < 2) {
        return invalidToolCall("web_search.query must be at least 2 characters");
      }

      if (input.query.length > 500) {
        return invalidToolCall("web_search.query is too long");
      }

      return {
        ok: true,
        call: {
          type: "web_search",
          query: input.query.trim(),
        },
      };
    }

    case "web_fetch": {
      if (typeof input.url !== "string") {
        return invalidToolCall("web_fetch.url must be a string");
      }

      if (input.url.length === 0 || input.url.length > 2_048) {
        return invalidToolCall("web_fetch.url must be between 1 and 2048 characters");
      }

      const urlValidation = validateWebFetchUrl(input.url);

      if (!urlValidation.ok) {
        return {
          ok: false,
          error: {
            code: "WEB_FETCH_URL_INVALID",
            message: urlValidation.message,
          },
        };
      }

      return {
        ok: true,
        call: {
          type: "web_fetch",
          url: input.url,
        },
      };
    }

    default:
      return invalidToolCall(`Unknown tool type: ${input.type}`);
  }
}
