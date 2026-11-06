import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getErrorMessage } from "../shared/runtime.ts";
import type { ToolResult, WorkspacePathResult } from "../tools/contracts.ts";

export const MAX_FILE_BYTES = 200_000;

export function isInsideWorkspace(root: string, target: string): boolean {
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

export async function resolveWorkspaceFile(
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

export async function checkRegularFile(
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
