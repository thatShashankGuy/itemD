import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

function pathError(code: "PATH_OUTSIDE_WORKSPACE" | "PATH_BLOCKED", message: string): WorkspacePathResult {
  return {
    ok: false,
    error: { code, message },
  };
}

function validateCandidatePath(
  workspaceRoot: string,
  candidate: string,
): WorkspacePathResult | undefined {
  if (!isInsideWorkspace(workspaceRoot, candidate)) {
    return pathError(
      "PATH_OUTSIDE_WORKSPACE",
      "Path resolves outside the workspace",
    );
  }

  if (isBlockedWorkspacePath(workspaceRoot, candidate)) {
    return pathError("PATH_BLOCKED", "Access to this workspace path is blocked");
  }

  return undefined;
}

async function validateRealTarget(
  workspaceRoot: string,
  target: string,
): Promise<WorkspacePathResult> {
  if (!isInsideWorkspace(workspaceRoot, target)) {
    return pathError(
      "PATH_OUTSIDE_WORKSPACE",
      "Symlink target resolves outside the workspace",
    );
  }

  if (isBlockedWorkspacePath(workspaceRoot, target)) {
    return pathError("PATH_BLOCKED", "Access to this workspace path is blocked");
  }

  return { ok: true, path: target };
}

function isBlockedWorkspacePath(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  const firstPart = relativePath.split(/[\\/]/)[0] ?? "";

  return (
    firstPart === ".git" ||
    firstPart === ".itemd" ||
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

  const candidateError = validateCandidatePath(workspaceRoot, candidate);

  if (candidateError !== undefined) {
    return candidateError;
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

  return validateRealTarget(workspaceRoot, realTarget);
}

/**
 * Resolves a file path that may not exist yet. Existing ancestors are realpath
 * checked so a new file cannot be created through a symlink escaping the
 * workspace.
 */
export async function resolveWorkspaceFileForWrite(
  workspaceRoot: string,
  requestedPath: string,
): Promise<WorkspacePathResult> {
  const candidate = resolve(workspaceRoot, requestedPath);
  const candidateError = validateCandidatePath(workspaceRoot, candidate);

  if (candidateError !== undefined) {
    return candidateError;
  }

  try {
    const existingTarget = await realpath(candidate);
    const targetValidation = await validateRealTarget(
      workspaceRoot,
      existingTarget,
    );

    if (!targetValidation.ok) {
      return targetValidation;
    }

    const metadata = await lstat(candidate);

    if (!metadata.isFile()) {
      return {
        ok: false,
        error: {
          code: "FILE_NOT_REGULAR",
          message: "File is not regular",
        },
      };
    }

    return { ok: true, path: candidate };
  } catch {
    // A dangling symlink can make realpath fail while writeFile would still
    // follow it. Reject it before considering this a new file.
    try {
      const metadata = await lstat(candidate);

      if (metadata.isSymbolicLink()) {
        return pathError(
          "PATH_OUTSIDE_WORKSPACE",
          "Symlink target cannot be resolved safely",
        );
      }
    } catch {
      // The path is absent; continue with the nearest existing parent.
    }
  }

  let parent = dirname(candidate);

  while (isInsideWorkspace(workspaceRoot, parent)) {
    try {
      const realParent = await realpath(parent);
      const parentValidation = await validateRealTarget(
        workspaceRoot,
        realParent,
      );

      if (!parentValidation.ok) {
        return parentValidation;
      }

      return { ok: true, path: candidate };
    } catch {
      const nextParent = dirname(parent);

      if (nextParent === parent) {
        break;
      }

      parent = nextParent;
    }
  }

  return {
    ok: false,
    error: {
      code: "PATH_OUTSIDE_WORKSPACE",
      message: "File parent does not resolve inside the workspace",
    },
  };
}

export async function resolveWorkspaceDirectory(
  workspaceRoot: string,
  requestedPath = ".",
): Promise<WorkspacePathResult> {
  const resolved = await resolveWorkspaceFile(workspaceRoot, requestedPath);

  if (!resolved.ok) {
    return resolved;
  }

  try {
    const metadata = await stat(resolved.path);

    if (!metadata.isDirectory()) {
      return {
        ok: false,
        error: {
          code: "FILE_NOT_REGULAR",
          message: "Path is not a directory",
        },
      };
    }

    return resolved;
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
