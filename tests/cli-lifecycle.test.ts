import { describe, expect, test } from "vitest";
import {
  getReleaseAsset,
  uninstallStandalone,
  updateStandalone,
} from "../src/cli/lifecycle.ts";

describe("standalone lifecycle commands", () => {
  test("maps each supported target to its release asset", () => {
    expect(getReleaseAsset("linux", "x64")).toEqual({
      name: "itemd-linux-x64",
      executableName: "itemd",
    });
    expect(getReleaseAsset("darwin", "arm64")).toEqual({
      name: "itemd-macos-arm64",
      executableName: "itemd",
    });
    expect(getReleaseAsset("win32", "x64")).toEqual({
      name: "itemd-windows-x64.exe",
      executableName: "itemd.exe",
    });
  });

  test("rejects unsupported targets", () => {
    expect(getReleaseAsset("linux", "arm64")).toBeUndefined();
    expect(getReleaseAsset("darwin", "x64")).toBeUndefined();
  });

  test("keeps update and uninstall limited to standalone releases", async () => {
    await expect(
      updateStandalone({ standalone: false }),
    ).resolves.toEqual({
      ok: false,
      error: "--update is available only in a standalone itemD release.",
    });
    await expect(
      uninstallStandalone({ standalone: false }),
    ).resolves.toEqual({
      ok: false,
      error: "--uninstall is available only in a standalone itemD release.",
    });
  });
});
