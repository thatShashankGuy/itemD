import { spawn } from "node:child_process";
import {
  chmod,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getErrorMessage, isStandaloneExecutable } from "../shared/runtime.ts";

const RELEASE_BASE_URL =
  "https://github.com/thatShashankGuy/itemd/releases/latest/download";

export type ReleaseAsset = {
  name: string;
  executableName: string;
};

export type LifecycleResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export type LifecycleOptions = {
  arch?: NodeJS.Architecture;
  executablePath?: string;
  fetcher?: typeof fetch;
  platform?: NodeJS.Platform;
  standalone?: boolean;
};

export function getReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): ReleaseAsset | undefined {
  if (platform === "linux" && arch === "x64") {
    return { name: "itemd-linux-x64", executableName: "itemd" };
  }

  if (platform === "darwin" && arch === "arm64") {
    return { name: "itemd-macos-arm64", executableName: "itemd" };
  }

  if (platform === "win32" && arch === "x64") {
    return {
      name: "itemd-windows-x64.exe",
      executableName: "itemd.exe",
    };
  }

  return undefined;
}

function quotePowerShellPath(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

function scheduleWindowsFileAction(
  action: "move" | "remove",
  source: string,
  destination?: string,
): void {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Start-Sleep -Milliseconds 500",
    action === "move"
      ? `Move-Item -LiteralPath ${quotePowerShellPath(source)} -Destination ${quotePowerShellPath(destination ?? "")} -Force`
      : `Remove-Item -LiteralPath ${quotePowerShellPath(source)} -Force`,
  ].join("; ");

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
}

async function removeTemporaryFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

function isStandalone(options: LifecycleOptions): boolean {
  return options.standalone ?? isStandaloneExecutable();
}

export async function updateStandalone(
  options: LifecycleOptions = {},
): Promise<LifecycleResult> {
  if (!isStandalone(options)) {
    return {
      ok: false,
      error: "--update is available only in a standalone itemd release.",
    };
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = getReleaseAsset(platform, arch);

  if (asset === undefined) {
    return {
      ok: false,
      error: `No itemd release is available for ${platform}/${arch}.`,
    };
  }

  const executablePath = options.executablePath ?? process.execPath;
  const temporaryPath = join(
    dirname(executablePath),
    `.${asset.executableName}.update-${randomUUID()}`,
  );
  const fetcher = options.fetcher ?? fetch;

  try {
    const response = await fetcher(`${RELEASE_BASE_URL}/${asset.name}`);

    if (!response.ok) {
      return {
        ok: false,
        error: `Latest itemd release download failed with HTTP ${response.status}.`,
      };
    }

    const contents = new Uint8Array(await response.arrayBuffer());

    if (contents.byteLength === 0) {
      return {
        ok: false,
        error: "Latest itemd release download was empty.",
      };
    }

    await writeFile(temporaryPath, contents, { mode: 0o755 });

    if (platform === "win32") {
      scheduleWindowsFileAction("move", temporaryPath, executablePath);
    } else {
      const existing = await stat(executablePath).catch(() => undefined);
      await chmod(
        temporaryPath,
        existing === undefined ? 0o755 : existing.mode & 0o777,
      );
      await rename(temporaryPath, executablePath);
    }

    return {
      ok: true,
      message:
        platform === "win32"
          ? "itemd update downloaded. Restart itemd to use the new version."
          : "itemd updated. Restart itemd to use the new version.",
    };
  } catch (error: unknown) {
    await removeTemporaryFile(temporaryPath);
    return {
      ok: false,
      error: `Unable to update itemd: ${getErrorMessage(error)}`,
    };
  }
}

export async function uninstallStandalone(
  options: LifecycleOptions = {},
): Promise<LifecycleResult> {
  if (!isStandalone(options)) {
    return {
      ok: false,
      error: "--uninstall is available only in a standalone itemd release.",
    };
  }

  const executablePath = options.executablePath ?? process.execPath;

  try {
    if ((options.platform ?? process.platform) === "win32") {
      scheduleWindowsFileAction("remove", executablePath);
    } else {
      await unlink(executablePath);
    }

    return {
      ok: true,
      message:
        "itemd uninstalled. Your saved configuration and workspace traces were preserved.",
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: `Unable to uninstall itemd: ${getErrorMessage(error)}`,
    };
  }
}
