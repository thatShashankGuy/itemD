import {
  lstat,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";
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
  resolveWorkspaceDirectory,
  resolveWorkspaceFile,
  resolveWorkspaceFileForWrite,
} from "../workspace/files.ts";
import type { SearchProvider } from "../web/provider.ts";

const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_OUTPUT_CHARS = 50_000;

type ListedFile = {
  path: string;
  type: "file" | "directory" | "symlink";
};

type SearchMatch = {
  path: string;
  line: number;
  text: string;
};

export type ToolExecutionOptions = {
  webSearchProvider?: SearchProvider;
};

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

async function executeWriteFile(
  call: Extract<ToolCall, { type: "write_file" }>,
  workspaceRoot: string,
): Promise<ToolResult<{ path: string; bytes: number; created: boolean }>> {
  const resolvedPath = await resolveWorkspaceFileForWrite(
    workspaceRoot,
    call.path,
  );

  if (!resolvedPath.ok) {
    return resolvedPath;
  }

  const bytes = Buffer.byteLength(call.content, "utf8");

  if (bytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: {
        code: "FILE_TOO_LARGE",
        message: `Written file would exceed ${MAX_FILE_BYTES} bytes`,
      },
    };
  }

  let created = true;

  try {
    const metadata = await lstat(resolvedPath.path);
    created = false;

    if (!metadata.isFile()) {
      return {
        ok: false,
        error: {
          code: "FILE_NOT_REGULAR",
          message: "File is not regular",
        },
      };
    }
  } catch {
    // A missing file is the create case.
  }

  try {
    await writeFile(resolvedPath.path, call.content, "utf8");

    return {
      ok: true,
      output: { path: call.path, bytes, created },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "FILE_WRITE_FAILED",
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

async function executeDeleteFile(
  call: Extract<ToolCall, { type: "delete_file" }>,
  workspaceRoot: string,
): Promise<ToolResult<{ path: string }>> {
  const resolvedPath = await resolveWorkspaceFileForWrite(
    workspaceRoot,
    call.path,
  );

  if (!resolvedPath.ok) {
    return resolvedPath;
  }

  try {
    const metadata = await lstat(resolvedPath.path);

    if (!metadata.isFile()) {
      return {
        ok: false,
        error: {
          code: "FILE_NOT_REGULAR",
          message: "File is not regular",
        },
      };
    }

    await unlink(resolvedPath.path);

    return {
      ok: true,
      output: { path: call.path },
    };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        ok: false,
        error: {
          code: "PATH_NOT_FOUND",
          message: "Workspace file does not exist",
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "FILE_DELETE_FAILED",
        message: getErrorMessage(error),
      },
    };
  }
}

function workspaceRelativePath(workspaceRoot: string, filePath: string): string {
  const value = relative(workspaceRoot, filePath).replaceAll("\\", "/");
  return value.length === 0 ? "." : value;
}

async function executeListFiles(
  call: Extract<ToolCall, { type: "list_files" }>,
  workspaceRoot: string,
): Promise<ToolResult<{ path: string; entries: ListedFile[]; truncated: boolean }>> {
  const resolvedDirectory = await resolveWorkspaceDirectory(
    workspaceRoot,
    call.path,
  );

  if (!resolvedDirectory.ok) {
    return resolvedDirectory;
  }

  try {
    const directoryEntries = await readdir(resolvedDirectory.path, {
      withFileTypes: true,
    });
    const entries: ListedFile[] = [];

    for (const entry of directoryEntries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        break;
      }

      const entryPath = resolve(resolvedDirectory.path, entry.name);
      const relativeEntryPath = workspaceRelativePath(workspaceRoot, entryPath);
      const safetyCheck = await resolveWorkspaceFile(
        workspaceRoot,
        relativeEntryPath,
      );

      if (!safetyCheck.ok) {
        continue;
      }

      const type = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : undefined;

      if (type !== undefined) {
        entries.push({ path: relativeEntryPath, type });
      }
    }

    return {
      ok: true,
      output: {
        path: call.path ?? ".",
        entries,
        truncated: directoryEntries.length > MAX_LIST_ENTRIES,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "DIRECTORY_READ_FAILED",
        message: getErrorMessage(error),
      },
    };
  }
}

async function executeSearchFiles(
  call: Extract<ToolCall, { type: "search_files" }>,
  workspaceRoot: string,
): Promise<ToolResult<{ query: string; matches: SearchMatch[]; truncated: boolean }>> {
  const resolvedDirectory = await resolveWorkspaceDirectory(
    workspaceRoot,
    call.path,
  );

  if (!resolvedDirectory.ok) {
    return resolvedDirectory;
  }

  const matches: SearchMatch[] = [];
  let outputChars = 0;
  let truncated = false;

  async function visit(directoryPath: string): Promise<void> {
    if (matches.length >= MAX_SEARCH_MATCHES || truncated) {
      truncated = true;
      return;
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (matches.length >= MAX_SEARCH_MATCHES || truncated) {
        truncated = true;
        return;
      }

      const entryPath = resolve(directoryPath, entry.name);
      const relativeEntryPath = workspaceRelativePath(workspaceRoot, entryPath);
      const safetyCheck = await resolveWorkspaceFile(
        workspaceRoot,
        relativeEntryPath,
      );

      if (!safetyCheck.ok) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileCheck = await checkRegularFile(safetyCheck.path);

      if (!fileCheck.ok) {
        continue;
      }

      const content = await readFile(safetyCheck.path, "utf8");
      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";

        if (!line.includes(call.query)) {
          continue;
        }

        const match: SearchMatch = {
          path: relativeEntryPath,
          line: index + 1,
          text: line.slice(0, 500),
        };
        const matchSize = JSON.stringify(match).length;

        if (outputChars + matchSize > MAX_SEARCH_OUTPUT_CHARS) {
          truncated = true;
          return;
        }

        matches.push(match);
        outputChars += matchSize;
      }
    }
  }

  try {
    await visit(resolvedDirectory.path);

    return {
      ok: true,
      output: { query: call.query, matches, truncated },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "SEARCH_FAILED",
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

async function executeWebSearch(
  call: Extract<ToolCall, { type: "web_search" }>,
  provider: SearchProvider | undefined,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (provider === undefined) {
    return {
      ok: false,
      error: {
        code: "WEB_SEARCH_DISABLED",
        message:
          "Web search is disabled. Enable it and configure a Serper API key first.",
      },
    };
  }

  const result = await provider.search(call.query, signal);

  return result.ok
    ? result
    : {
        ok: false,
        error: {
          code: "WEB_SEARCH_FAILED",
          message: result.error.message,
          ...(result.error.status === undefined
            ? {}
            : { details: { status: result.error.status } }),
        },
      };
}

async function executeWebFetch(
  call: Extract<ToolCall, { type: "web_fetch" }>,
  provider: SearchProvider | undefined,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (provider === undefined) {
    return {
      ok: false,
      error: {
        code: "WEB_SEARCH_DISABLED",
        message:
          "Web fetch is disabled. Enable web search and configure a Serper API key first.",
      },
    };
  }

  const result = await provider.fetch(call.url, signal);

  return result.ok
    ? result
    : {
        ok: false,
        error: {
          code: "WEB_FETCH_FAILED",
          message: result.error.message,
          ...(result.error.status === undefined
            ? {}
            : { details: { status: result.error.status } }),
        },
      };
}

// Tool dispatcher

export async function executeTool(
  input: unknown,
  workspaceRoot: string,
  signal?: AbortSignal,
  options: ToolExecutionOptions = {},
): Promise<ToolResult> {
  const validation = validateToolCall(input);

  if (!validation.ok) {
    return validation;
  }

  switch (validation.call.type) {
    case "read_file":
      return executeReadFile(validation.call, workspaceRoot);

    case "write_file":
      return executeWriteFile(validation.call, workspaceRoot);

    case "edit_file":
      return executeEditFile(validation.call, workspaceRoot);

    case "delete_file":
      return executeDeleteFile(validation.call, workspaceRoot);

    case "list_files":
      return executeListFiles(validation.call, workspaceRoot);

    case "search_files":
      return executeSearchFiles(validation.call, workspaceRoot);

    case "shell":
      return executeShell(validation.call, workspaceRoot, signal);

    case "web_search":
      return executeWebSearch(
        validation.call,
        options.webSearchProvider,
        signal,
      );

    case "web_fetch":
      return executeWebFetch(
        validation.call,
        options.webSearchProvider,
        signal,
      );
  }
}
