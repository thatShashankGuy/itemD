import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ITEMD_CONFIG_VERSION,
  readConfiguration,
  writeConfiguration,
  type ConfigurationOptions,
  type ItemDConfiguration,
} from "./configuration.ts";
import { PROVIDER_CATALOG } from "../model/catalog.ts";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_HOST = "127.0.0.1";

export type BrowserSetupResult =
  | { status: "saved" }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

export type BrowserSetupOptions = {
  config?: ConfigurationOptions;
  initialConfiguration?: ItemDConfiguration;
  host?: string;
  port?: number;
  openBrowser?: (url: string) => Promise<void>;
  signal?: AbortSignal;
  theme?: "dark" | "light";
};

type BrowserTheme = "dark" | "light";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

function sendHtml(
  response: ServerResponse<IncomingMessage>,
  status: number,
  html: string,
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function page(title: string, body: string, theme: BrowserTheme = "dark"): string {
  const palette = theme === "light"
    ? {
        background: "#f6f8fa",
        panel: "#ffffff",
        border: "#afb8c1",
        input: "#f0f2f4",
        text: "#1f2328",
        muted: "#59636e",
        accent: "#c62828",
        errorBackground: "#ffebe9",
        error: "#cf222e",
      }
    : {
        background: "#0d1117",
        panel: "#161b22",
        border: "#30363d",
        input: "#0d1117",
        text: "#f0f3f6",
        muted: "#8b949e",
        accent: "#f04444",
        errorBackground: "#3d1c1c",
        error: "#ff7b72",
      };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — itemd</title>
  <style>
    :root { color-scheme: ${theme}; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${palette.background}; color: ${palette.text}; }
    main { width: min(34rem, calc(100vw - 2rem)); box-sizing: border-box; padding: 2rem; border: 1px solid ${palette.border}; border-radius: 12px; background: ${palette.panel}; }
    h1 { margin-top: 0; color: ${palette.accent}; }
    p, label { color: ${palette.text}; }
    label { display: block; margin: 1rem 0 .35rem; }
    input, select { box-sizing: border-box; width: 100%; padding: .65rem; border: 1px solid ${palette.border}; border-radius: 6px; background: ${palette.input}; color: ${palette.text}; }
    .check { display: flex; gap: .6rem; align-items: center; }
    .check input { width: auto; }
    button { margin-top: 1.25rem; padding: .65rem 1rem; border: 0; border-radius: 6px; background: ${palette.accent}; color: white; cursor: pointer; }
    button.secondary { margin-left: .5rem; background: ${palette.border}; color: ${palette.text}; }
    .hint { font-size: .9rem; color: ${palette.muted}; }
    .error { padding: .75rem; border-radius: 6px; background: ${palette.errorBackground}; color: ${palette.error}; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function setupForm(
  token: string,
  stored: ItemDConfiguration | null,
  initial: ItemDConfiguration,
  error?: string,
  theme: BrowserTheme = "dark",
): string {
  const provider = PROVIDER_CATALOG.find(
    (candidate) => candidate.id === initial.provider && candidate.enabled,
  ) ?? PROVIDER_CATALOG[0];

  if (!provider.enabled) {
    return page("Setup unavailable", "<h1>Setup unavailable</h1>", theme);
  }

  const modelOptions = provider.models
    .map(
      (model) =>
        `<option value="${escapeHtml(model.id)}"${model.id === initial.model ? " selected" : ""}>${escapeHtml(model.displayName)}</option>`,
    )
    .join("");
  const effortOptions = provider.reasoningEfforts
    .map(
      (effort) =>
        `<option value="${escapeHtml(effort.id)}"${effort.id === initial.effort ? " selected" : ""}>${escapeHtml(effort.displayName)}</option>`,
    )
    .join("");
  const modelKeyHint = stored === null
    ? "Required. Keys are stored only in the user-level itemd configuration."
    : "Leave blank to keep the saved key. Keys are never shown back to you.";
  const serperKeyHint = stored?.webSearch?.serperApiKey
    ? "Leave blank to keep the saved key."
    : "Optional unless web search is enabled.";

  return page(
    "Configuration",
    `${error === undefined ? "" : `<p class="error">${escapeHtml(error)}</p>`}
    <h1>Configure itemd</h1>
    <p>Choose the model settings and enter credentials. Return to the itemd terminal when you save.</p>
    <form method="post" action="/?token=${encodeURIComponent(token)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <label for="model">Model</label>
      <select id="model" name="model">${modelOptions}</select>
      <label for="effort">Reasoning effort</label>
      <select id="effort" name="effort">${effortOptions}</select>
      <label for="apiKey">DeepSeek API key</label>
      <input id="apiKey" name="apiKey" type="password" autocomplete="new-password">
      <p class="hint">${escapeHtml(modelKeyHint)}</p>
      <label class="check"><input name="webSearch" value="true" type="checkbox"${initial.webSearch?.enabled ? " checked" : ""}> Enable web search</label>
      <label for="serperApiKey">Serper API key</label>
      <input id="serperApiKey" name="serperApiKey" type="password" autocomplete="new-password">
      <p class="hint">${escapeHtml(serperKeyHint)}</p>
      <button type="submit">Save configuration</button>
      <button class="secondary" type="submit" formaction="/?token=${encodeURIComponent(token)}&cancel=1">Cancel</button>
    </form>`,
    theme,
  );
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        request.destroy(new Error("request body too large"));
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

export function openBrowserUrl(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd.exe"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function runBrowserSetup(
  options: BrowserSetupOptions = {},
): Promise<BrowserSetupResult> {
  const configOptions = options.config ?? {};
  const storedResult = await readConfiguration(configOptions);
  const stored = storedResult.ok ? storedResult.configuration : null;
  const provider = PROVIDER_CATALOG[0];
  const initial = options.initialConfiguration ?? stored ?? {
    version: ITEMD_CONFIG_VERSION,
    provider: provider.id,
    model: provider.defaultModel,
    effort: provider.defaultEffort,
    apiKey: "",
    webSearch: { enabled: false, serperApiKey: "" },
  };
  const token = randomBytes(24).toString("hex");
  const host = options.host ?? DEFAULT_HOST;
  const openBrowser = options.openBrowser ?? openBrowserUrl;
  const theme: BrowserTheme = options.theme === "light" ? "light" : "dark";

  return new Promise((resolve) => {
    let settled = false;
    let removeAbortListener = (): void => undefined;
    const finish = (result: BrowserSetupResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      resolve(result);
    };

    const server = createServer(async (request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${host}`,
      );

      if (requestUrl.searchParams.get("token") !== token) {
        sendHtml(response, 403, page("Forbidden", "<h1>Setup link expired.</h1>", theme));
        return;
      }

      if (requestUrl.searchParams.get("cancel") === "1") {
        sendHtml(response, 200, page("Cancelled", "<h1>Setup cancelled</h1><p>You can close this tab and return to itemd.</p>", theme));
        closeServer();
        finish({ status: "cancelled" });
        return;
      }

      if (request.method === "GET") {
        sendHtml(response, 200, setupForm(token, stored, initial, undefined, theme));
        return;
      }

      if (request.method !== "POST") {
        sendHtml(response, 405, page("Method not allowed", "<h1>Method not allowed</h1>", theme));
        return;
      }

      try {
        const fields = new URLSearchParams(await readBody(request));
        const model = fields.get("model") ?? "";
        const effort = fields.get("effort") ?? "";
        const selectedModel = provider.models.find((candidate) => candidate.id === model);
        const selectedEffort = provider.reasoningEfforts.find((candidate) => candidate.id === effort);
        const apiKey = fields.get("apiKey")?.trim() || stored?.apiKey || "";
        const webSearchEnabled = fields.get("webSearch") === "true";
        const serperApiKey = fields.get("serperApiKey")?.trim() || stored?.webSearch?.serperApiKey || "";

        if (selectedModel === undefined || selectedEffort === undefined) {
          sendHtml(response, 400, setupForm(token, stored, initial, "Choose a supported model and reasoning effort.", theme));
          return;
        }
        if (apiKey.length === 0) {
          sendHtml(response, 400, setupForm(token, stored, initial, "DeepSeek API key is required.", theme));
          return;
        }
        if (webSearchEnabled && serperApiKey.length === 0) {
          sendHtml(response, 400, setupForm(token, stored, initial, "A Serper API key is required when web search is enabled.", theme));
          return;
        }

        const writeResult = await writeConfiguration({
          version: ITEMD_CONFIG_VERSION,
          provider: provider.id,
          model: selectedModel.id,
          effort: selectedEffort.id,
          apiKey,
          webSearch: {
            enabled: webSearchEnabled,
            serperApiKey,
          },
        }, configOptions);

        if (!writeResult.ok) {
          sendHtml(response, 500, setupForm(token, stored, initial, writeResult.error.message, theme));
          return;
        }

        sendHtml(response, 200, page("Saved", "<h1>Configuration saved</h1><p>You can close this tab and return to itemd.</p>", theme));
        closeServer();
        finish({ status: "saved" });
      } catch {
        sendHtml(response, 400, setupForm(token, stored, initial, "The setup request could not be processed.", theme));
      }
    });

    server.once("error", (error: Error) => {
      finish({ status: "failed", message: "Unable to start the local configuration page." });
      void error;
    });
    const closeServer = (): void => {
      if (server.listening) {
        server.close();
        server.closeAllConnections();
      }
    };
    const onAbort = (): void => {
      closeServer();
      finish({ status: "cancelled" });
    };
    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        options.signal?.removeEventListener("abort", onAbort);
      };
      if (options.signal.aborted) {
        onAbort();
      }
    }
    server.listen(options.port ?? 0, host, () => {
      if (options.signal?.aborted) {
        closeServer();
        return;
      }

      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;

      if (port === undefined) {
        closeServer();
        finish({ status: "failed", message: "Unable to determine the configuration page address." });
        return;
      }

      const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
      void openBrowser(url).catch(() => {
        closeServer();
        finish({
          status: "failed",
          message: "Unable to open the browser for itemd setup.",
        });
      });
    });
  });
}
