import {
  mkdtemp,
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
import { runWeb } from "../src/ui/web.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function withToken(base: string, path: string): string {
  const baseUrl = new URL(base);
  const target = new URL(path, baseUrl);
  target.searchParams.set("token", baseUrl.searchParams.get("token") ?? "");
  return target.toString();
}

describe("web UI", () => {
  test("serves the full UI and applies authenticated configuration commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "itemd-web-ui-"));
    directories.push(directory);
    const configPath = join(directory, "config", "itemd.json");
    await writeConfiguration(
      {
        version: ITEMD_CONFIG_VERSION,
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
        apiKey: "web-ui-test-key",
      },
      { configPath, env: {} },
    );

    let browserUrl: string | undefined;
    let browserReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      browserReady = resolve;
    });
    const controller = new AbortController();
    const server = runWeb({
      workspaceRoot: directory,
      config: { configPath, env: {} },
      signal: controller.signal,
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
    expect(html).toContain("itemD — web workspace");
    expect(html).toContain("/assets/logo.png");
    expect(html).toContain("Describe a task");
    expect(html).toContain("Web view is experimental.");
    expect(html).toContain("https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js");
    expect(html).toContain("Configure");
    expect(html).toContain("aria-labelledby=\"config-title\"");
    expect(html).toContain("--scrim: rgb(255 255 255 / .7)");
    expect(html).toContain("<textarea");
    expect(html).toContain("@keydown=\"handleInputKeydown($event)\"");
    expect(html).toContain("if (event.shiftKey) return;");
    expect(html).toContain("event.key === 'Tab'");
    expect(html).toContain("selectedCommandIndex");
    expect(html).toContain("min-height: 20vh");
    expect(html).toContain("argumentHint");
    expect(html).toContain("requiresArgument: true");
    expect(html).toContain("prepareCommand(command)");
    expect(html).toContain("line.startsWith('/') && command === undefined");
    expect(html).toContain("pickerItems");
    expect(html).toContain("Recorded runs");
    expect(html).toContain("Recent sessions");
    expect(html).toContain("action: '/replay'");
    expect(html).toContain("action: '/resume'");
    expect(html).toContain("@keydown.escape.window=\"handleEscape()\"");
    expect(html).toContain("#logo { width: 64px; height: 56px");
    expect(html).toContain("class=\"controls\"");
    expect(html).toContain("filteredCommands");
    expect(html).not.toContain(">Send</button>");
    expect(html).not.toContain("class=\"sidebar\"");

    const editorResponse = await fetch(withToken(browserUrl!, "/api/input"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line: "$editor" }),
    });
    expect(editorResponse.status).toBe(200);
    expect(await editorResponse.json()).toMatchObject({
      message: expect.stringContaining("terminal composer"),
      tone: "warning",
    });

    const stateResponse = await fetch(withToken(browserUrl!, "/api/state"));
    expect(stateResponse.status).toBe(200);
    expect(await stateResponse.json()).toMatchObject({
      state: {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
        busy: false,
      },
    });

    const sessionsResponse = await fetch(withToken(browserUrl!, "/api/input"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line: "/sessions" }),
    });
    const sessionsResult = await sessionsResponse.json();
    expect(sessionsResponse.status).toBe(200);
    expect(sessionsResult.sessions).toHaveLength(1);

    const resumeResponse = await fetch(withToken(browserUrl!, "/api/input"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line: "/resume " + sessionsResult.sessions[0].id }),
    });
    expect(resumeResponse.status).toBe(200);
    expect(await resumeResponse.json()).toMatchObject({
      session: { id: sessionsResult.sessions[0].id },
      messages: [],
    });

    const commandResponse = await fetch(withToken(browserUrl!, "/api/input"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line: "/model deepseek-v4-pro" }),
    });
    expect(commandResponse.status).toBe(200);
    expect(await commandResponse.json()).toMatchObject({
      message: "Model set to deepseek-v4-pro.",
    });
    await expect(readConfiguration({ configPath, env: {} })).resolves.toMatchObject({
      ok: true,
      configuration: { model: "deepseek-v4-pro" },
    });

    const unauthorized = await fetch(new URL("/api/state", browserUrl!));
    expect(unauthorized.status).toBe(403);

    controller.abort();
    await server;
  });
});
