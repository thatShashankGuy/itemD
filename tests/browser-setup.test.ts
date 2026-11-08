import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ITEMD_CONFIG_VERSION,
  readConfiguration,
  writeConfiguration,
} from "../src/config/configuration.ts";
import { runBrowserSetup } from "../src/config/browser-setup.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("browser configuration setup", () => {
  test("saves model, effort, and credentials through a loopback page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "itemd-browser-setup-"));
    directories.push(directory);
    const configPath = join(directory, "config", "itemd.json");
    let browserUrl: string | undefined;
    let browserReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      browserReady = resolve;
    });

    const setup = runBrowserSetup({
      config: { configPath, env: {} },
      openBrowser: async (url) => {
        browserUrl = url;
        browserReady?.();
      },
    });

    await ready;
    expect(browserUrl).toBeDefined();

    const page = await fetch(browserUrl!);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("DeepSeek API key");
    expect(html).toContain("deepseek-v4-pro");
    expect(html).not.toContain("secret");

    const response = await fetch(browserUrl!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: new URL(browserUrl!).searchParams.get("token")!,
        model: "deepseek-v4-pro",
        effort: "max",
        apiKey: "model-secret",
        webSearch: "true",
        serperApiKey: "serper-secret",
      }),
    });

    expect(response.status).toBe(200);
    expect(await setup).toEqual({ status: "saved" });
    const stored = await readConfiguration({ configPath, env: {} });
    expect(stored).toMatchObject({
      ok: true,
      configuration: {
        version: ITEMD_CONFIG_VERSION,
        model: "deepseek-v4-pro",
        effort: "max",
        apiKey: "model-secret",
        webSearch: {
          enabled: true,
          serperApiKey: "serper-secret",
        },
      },
    });
    expect(await readFile(configPath, "utf8")).toContain("model-secret");
  });

  test("cancels without changing the existing configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "itemd-browser-setup-"));
    directories.push(directory);
    const configPath = join(directory, "config", "itemd.json");
    await writeConfiguration(
      {
        version: ITEMD_CONFIG_VERSION,
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
        apiKey: "existing-secret",
      },
      { configPath, env: {} },
    );
    let browserUrl: string | undefined;
    let browserReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      browserReady = resolve;
    });

    const setup = runBrowserSetup({
      config: { configPath, env: {} },
      openBrowser: async (url) => {
        browserUrl = url;
        browserReady?.();
      },
    });

    await ready;
    const response = await fetch(
      `${browserUrl}&cancel=1`,
    );
    expect(response.status).toBe(200);
    expect(await setup).toEqual({ status: "cancelled" });
    await expect(readConfiguration({ configPath, env: {} })).resolves.toMatchObject({
      ok: true,
      configuration: {
        apiKey: "existing-secret",
        model: "deepseek-flash",
      },
    });
  });
});
