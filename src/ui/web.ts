import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  runAgent,
  type AgentRunEvent,
  type AgentRunResult,
} from "../agent/runner.ts";
import {
  readConfiguration,
  resolveConfiguration,
  writeConfiguration,
  type ConfigurationOptions,
  type ItemDConfiguration,
} from "../config/configuration.ts";
import { runBrowserSetup, openBrowserUrl } from "../config/browser-setup.ts";
import type { ModelAdapter } from "../model/adapter.ts";
import { PROVIDER_CATALOG } from "../model/catalog.ts";
import { createModelAdapter } from "../model/factory.ts";
import { getErrorMessage, isRecord } from "../shared/runtime.ts";
import { listTraces, replayTrace, type ReplayResult } from "../telemetry/trace.ts";
import { executePrefixedShellCommand, formatShellResult } from "./shell.ts";
import { formatTuiCommandHelp } from "./commands.ts";
import type { SearchProvider } from "../web/provider.ts";
import { createSerperSearchProvider } from "../web/provider.ts";

const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 128 * 1024;
const MAX_EVENTS = 400;
const LOGO_NAME = "Just_One_More_Commit.png";

type ActiveConfiguration = {
  configuration: ItemDConfiguration;
  adapter: ModelAdapter;
  webSearchProvider?: SearchProvider;
};

type WebEvent =
  | { seq: number; type: "log"; label: string; message: string; tone?: string }
  | { seq: number; type: "reasoning"; step: number; text: string }
  | { seq: number; type: "status"; status: "ready" | "running" | "stopping" }
  | { seq: number; type: "state"; state: WebState }
  | { seq: number; type: "run"; result: AgentRunResult };

type WebEventInput =
  | { type: "log"; label: string; message: string; tone?: string }
  | { type: "reasoning"; step: number; text: string }
  | { type: "status"; status: "ready" | "running" | "stopping" }
  | { type: "state"; state: WebState }
  | { type: "run"; result: AgentRunResult };

type WebTone = "text" | "success" | "warning" | "error";

type WebState = {
  provider: string;
  model: string;
  effort: string;
  webSearch: boolean;
  workspace: string;
  busy: boolean;
};

export type WebOptions = {
  workspaceRoot: string;
  config?: ConfigurationOptions;
  host?: string;
  port?: number;
  openBrowser?: (url: string) => Promise<void>;
  signal?: AbortSignal;
};

type WebCommandResult = {
  message?: string;
  tone?: "text" | "success" | "warning" | "error";
  replays?: Array<{ traceId: string; modifiedAt: string }>;
  replay?: ReplayResult;
};

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
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

function createActiveConfiguration(
  configuration: ItemDConfiguration,
): { ok: true; active: ActiveConfiguration } | { ok: false; message: string } {
  const adapterResult = createModelAdapter(configuration);

  if (!adapterResult.ok) {
    return { ok: false, message: adapterResult.error.message };
  }

  const webSearchProvider = configuration.webSearch?.enabled === true
    ? createSerperSearchProvider({ apiKey: configuration.webSearch.serperApiKey })
    : undefined;

  return {
    ok: true,
    active: {
      configuration,
      adapter: adapterResult.adapter,
      ...(webSearchProvider === undefined ? {} : { webSearchProvider }),
    },
  };
}

async function loadActiveConfiguration(
  config: ConfigurationOptions,
): Promise<{ ok: true; active: ActiveConfiguration } | { ok: false; message: string }> {
  const result = await resolveConfiguration(config);

  if (!result.ok) {
    return { ok: false, message: result.error.message };
  }

  if (result.configuration === null) {
    return { ok: false, message: "No usable model configuration was found." };
  }

  return createActiveConfiguration(result.configuration);
}

function configurationState(
  active: ActiveConfiguration,
  workspaceRoot: string,
  busy: boolean,
): WebState {
  return {
    provider: active.configuration.provider,
    model: active.configuration.model,
    effort: active.configuration.effort,
    webSearch: active.configuration.webSearch?.enabled === true,
    workspace: basename(workspaceRoot),
    busy,
  };
}

function pageHtml(token: string): string {
  const tokenJson = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>itemD — web workspace</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117; --panel: #161b22; --panel-2: #1c2128; --border: #30363d;
      --text: #f0f3f6; --muted: #8b949e; --accent: #f04444; --success: #56d364;
      --warning: #e3b341; --error: #ff7b72; --user: #ff7b72;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    button, input, select { font: inherit; }
    button { border: 1px solid var(--border); border-radius: 6px; padding: .55rem .8rem; color: var(--text); background: var(--panel-2); cursor: pointer; }
    button:hover { border-color: var(--accent); }
    button.primary { color: white; border-color: var(--accent); background: var(--accent); }
    button.danger { color: var(--error); }
    body.light { --bg: #f6f8fa; --panel: #ffffff; --panel-2: #f0f2f4; --border: #afb8c1; --text: #1f2328; --muted: #59636e; --accent: #c62828; --success: #1a7f37; --warning: #9a6700; --error: #cf222e; --user: #b42318; }
    .app { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
    header { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem; border-bottom: 1px solid var(--border); background: var(--panel); }
    #logo { width: 64px; height: 40px; object-fit: contain; image-rendering: pixelated; }
    .brand { min-width: 0; flex: 1; }
    .brand h1 { margin: 0; color: var(--accent); font-size: 1.1rem; }
    .brand p { margin: .2rem 0 0; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status { color: var(--success); white-space: nowrap; }
    .status.running { color: var(--warning); }
    main { min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 270px; gap: 1rem; padding: 1rem; }
    .transcript, .sidebar, .composer { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
    .transcript { min-height: 0; overflow: auto; padding: 1rem; }
    .entry { margin-bottom: 1rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    .entry .label { color: var(--muted); margin-bottom: .2rem; }
    .entry.user .label { color: var(--user); }
    .entry.success .label { color: var(--success); }
    .entry.warning .label { color: var(--warning); }
    .entry.error .label { color: var(--error); }
    .entry.reasoning { color: var(--muted); border-left: 2px solid var(--border); padding-left: .75rem; }
    .sidebar { padding: 1rem; height: max-content; }
    .sidebar h2 { margin: 0 0 1rem; color: var(--accent); font-size: 1rem; }
    .sidebar label { display: block; margin: .8rem 0 .35rem; color: var(--muted); }
    select, input[type=text] { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: .55rem; color: var(--text); background: var(--bg); }
    .config-value { display: block; margin: .25rem 0; color: var(--text); }
    .sidebar .actions { display: grid; gap: .5rem; margin-top: 1rem; }
    .composer { grid-column: 1 / -1; display: flex; gap: .5rem; padding: .6rem; }
    .composer input { flex: 1; min-width: 0; }
    footer { min-height: 2rem; padding: .45rem 1rem; color: var(--muted); border-top: 1px solid var(--border); background: var(--panel); }
    .empty { color: var(--muted); padding: 2rem 0; text-align: center; }
    @media (max-width: 800px) { main { grid-template-columns: 1fr; } .sidebar { order: -1; } .composer { grid-column: auto; } }
  </style>
</head>
<body>
<div class="app">
  <header>
    <img id="logo" src="/assets/logo.png?token=${encodeURIComponent(token)}" alt="itemD logo">
    <div class="brand"><h1>itemD — web workspace</h1><p id="workspace">Connecting…</p></div>
    <div id="status" class="status">READY</div>
  </header>
  <main>
    <section id="transcript" class="transcript" aria-live="polite"><div class="empty">Type a coding task below, or use / for commands.</div></section>
    <aside class="sidebar">
      <h2>Configuration</h2>
      <label>Provider</label><span id="provider" class="config-value">—</span>
      <label for="model">Model</label><select id="model"></select>
      <label for="effort">Reasoning effort</label><select id="effort"></select>
      <span id="web-search" class="config-value">Web search: —</span>
      <div class="actions">
        <button id="setup">Open browser setup</button>
        <button id="reload">Reload configuration</button>
        <button id="theme">Toggle theme</button>
      </div>
    </aside>
    <form id="composer" class="composer">
      <input id="input" type="text" autocomplete="off" placeholder="Describe a task, type / for commands, or ! for shell">
      <button id="stop" class="danger" type="button" hidden>Stop</button>
      <button class="primary" type="submit">Send</button>
    </form>
  </main>
  <footer id="footer">Enter submits • / commands • ! shell • browser-local session</footer>
</div>
<script>
(() => {
  const token = ${tokenJson};
  const transcript = document.getElementById('transcript');
  const input = document.getElementById('input');
  const status = document.getElementById('status');
  const footer = document.getElementById('footer');
  const stop = document.getElementById('stop');
  const model = document.getElementById('model');
  const effort = document.getElementById('effort');
  let sequence = 0;
  let busy = false;
  let showingReasoning = false;

  const api = async (path, options = {}) => {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(path + separator + 'token=' + encodeURIComponent(token), {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || value.error || 'Request failed');
    return value;
  };
  const addEntry = (label, message, tone = 'text', extra = '') => {
    const entry = document.createElement('article');
    entry.className = 'entry ' + tone + (extra ? ' ' + extra : '');
    const heading = document.createElement('div'); heading.className = 'label'; heading.textContent = label;
    const content = document.createElement('div'); content.textContent = message;
    entry.append(heading, content); transcript.append(entry); transcript.scrollTop = transcript.scrollHeight;
  };
  const setState = (state) => {
    document.getElementById('provider').textContent = state.provider;
    document.getElementById('workspace').textContent = 'workspace: ' + state.workspace;
    document.getElementById('web-search').textContent = 'Web search: ' + (state.webSearch ? 'enabled' : 'disabled');
    busy = state.busy;
    status.textContent = busy ? 'RUNNING' : 'READY'; status.classList.toggle('running', busy); stop.hidden = !busy;
  };
  const applyEvents = (events) => events.forEach((event) => {
    sequence = Math.max(sequence, event.seq || sequence);
    if (event.type === 'log') addEntry(event.label, event.message, event.tone || 'text');
    if (event.type === 'reasoning' && showingReasoning) addEntry('reasoning step ' + event.step, event.text, 'reasoning', 'reasoning');
    if (event.type === 'status') { busy = event.status !== 'ready'; status.textContent = event.status.toUpperCase(); status.classList.toggle('running', busy); stop.hidden = !busy; }
    if (event.type === 'state') setState(event.state);
    if (event.type === 'run') {
      const result = event.result;
      addEntry(result.ok ? 'done' : result.status, result.ok ? result.answer : result.error.message, result.ok ? 'success' : 'error');
      addEntry('run', result.steps + ' step' + (result.steps === 1 ? '' : 's') + ' • trace ' + result.traceId, 'text');
    }
  });
  const refresh = async () => {
    try {
      const data = await api('/api/events?since=' + sequence);
      applyEvents(data.events || []);
    } catch (error) { footer.textContent = 'Connection error: ' + error.message; }
  };
  const sendLine = async (line) => {
    if (!line || busy) return;
    if (line === '/clear' || line === '/new') {
      transcript.innerHTML = '';
      addEntry('', line === '/new' ? 'New session started. Active configuration retained.' : 'Transcript cleared.', 'text');
      input.value = '';
      return;
    }
    if (line === '/theme' || line === '/theme light' || line === '/theme dark') {
      document.body.classList.toggle('light', line === '/theme light' || (line === '/theme' && !document.body.classList.contains('light')));
      input.value = '';
      return;
    }
    if (line === '/reasoning on') showingReasoning = true;
    if (line === '/reasoning off') showingReasoning = false;
    addEntry(line.startsWith('!') ? 'shell' : line.startsWith('/') ? 'command' : 'you', line, line.startsWith('/') ? 'text' : 'user');
    input.value = '';
    try {
      const result = await api('/api/input', { method: 'POST', body: JSON.stringify({ line }) });
      if (result.message) addEntry('itemD', result.message, result.tone || 'text');
      if (result.replays) result.replays.forEach((replay) => addEntry('replay', replay.traceId + '  ' + replay.modifiedAt, 'text'));
      if (result.replay && result.replay.ok) addEntry('replay ' + result.replay.traceId, JSON.stringify(result.replay.events, null, 2), 'text');
    } catch (error) { addEntry('error', error.message, 'error'); }
  };
  document.getElementById('composer').addEventListener('submit', (event) => { event.preventDefault(); void sendLine(input.value.trim()); });
  stop.addEventListener('click', async () => { await api('/api/stop', { method: 'POST', body: '{}' }); });
  document.getElementById('setup').addEventListener('click', () => void sendLine('/setup browser'));
  document.getElementById('reload').addEventListener('click', () => void sendLine('/reload'));
  document.getElementById('theme').addEventListener('click', () => document.body.classList.toggle('light'));
  model.addEventListener('change', () => void sendLine('/model ' + model.value));
  effort.addEventListener('change', () => void sendLine('/effort ' + effort.value));
  const load = async () => {
    try {
      const data = await api('/api/state');
      setState(data.state); model.innerHTML = data.models.map((item) => '<option value="' + item.id + '">' + item.displayName + '</option>').join(''); effort.innerHTML = data.efforts.map((item) => '<option value="' + item.id + '">' + item.displayName + '</option>').join(''); model.value = data.state.model; effort.value = data.state.effort;
      addEntry('', 'itemD is ready. Type a task below, / for commands, or ! for shell.', 'text');
      await refresh();
    } catch (error) { addEntry('error', error.message, 'error'); }
  };
  void load(); setInterval(() => void refresh(), 500); input.focus();
})();
</script>
</body>
</html>`;
}

async function loadLogo(): Promise<Uint8Array | null> {
  const bun = globalThis as {
    Bun?: { embeddedFiles?: readonly (Blob & { name?: string })[] };
  };
  const embedded = bun.Bun?.embeddedFiles?.find((file) => file.name?.includes(LOGO_NAME));

  if (embedded !== undefined) {
    return new Uint8Array(await embedded.arrayBuffer());
  }

  try {
    return await readFile(new URL(`../../assets/${LOGO_NAME}`, import.meta.url));
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export async function runWeb(options: WebOptions): Promise<void> {
  const config = options.config ?? {};
  let activeResult = await loadActiveConfiguration(config);

  if (!activeResult.ok) {
    const setupOptions = {
      config,
      ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const setup = await runBrowserSetup(setupOptions);
    if (setup.status !== "saved") {
      throw new Error(setup.status === "failed" ? setup.message : "Configuration setup cancelled.");
    }
    activeResult = await loadActiveConfiguration(config);
    if (!activeResult.ok) throw new Error(activeResult.message);
  }

  let active = activeResult.active;
  const logo = await loadLogo();
  const token = randomBytes(24).toString("hex");
  const host = options.host ?? DEFAULT_HOST;
  const openBrowser = options.openBrowser ?? openBrowserUrl;
  let sequence = 0;
  let events: WebEvent[] = [];
  let busy = false;
  let activeController: AbortController | null = null;
  let setupRunning = false;
  let showingReasoning = false;

  const emit = (event: WebEventInput): void => {
    const complete = { ...event, seq: ++sequence } as WebEvent;
    events.push(complete);
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  };
  const emitState = (): void => emit({ type: "state", state: configurationState(active, options.workspaceRoot, busy) });
  const emitLog = (message: string, label = "itemD  ", tone: WebTone = "text"): void => emit({ type: "log", label, message, tone });
  const loadReplacement = async (): Promise<boolean> => {
    const replacement = await loadActiveConfiguration(config);
    if (!replacement.ok) {
      emitLog(replacement.message, "configuration error  ", "error");
      return false;
    }
    active = replacement.active;
    emitState();
    return true;
  };
  const applySelection = async (selection: Partial<Pick<ItemDConfiguration, "model" | "effort">>): Promise<void> => {
    const storedResult = await readConfiguration(config);
    if (!storedResult.ok) { emitLog(storedResult.error.message, "configuration error  ", "error"); return; }
    if (storedResult.configuration === null) {
      const replacement = createActiveConfiguration({ ...active.configuration, ...selection });
      if (!replacement.ok) { emitLog(replacement.message, "configuration error  ", "error"); return; }
      active = replacement.active; emitState(); emitLog("Updated for this session.", "configuration  ", "success"); return;
    }
    const written = await writeConfiguration({ ...storedResult.configuration, ...selection }, config);
    if (!written.ok) { emitLog(written.error.message, "configuration error  ", "error"); return; }
    if (await loadReplacement()) emitLog("Saved and applied.", "configuration  ", "success");
  };
  const runSetup = (): void => {
    if (setupRunning) { emitLog("Browser setup is already open.", "configuration  ", "warning"); return; }
    setupRunning = true;
    emitLog("Browser setup opened. Return here after saving.", "configuration  ", "text");
    const setupOptions = {
      config,
      initialConfiguration: active.configuration,
      ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
    };
    void runBrowserSetup(setupOptions).then(async (result) => {
      setupRunning = false;
      if (result.status === "saved") { await loadReplacement(); emitLog("Configuration reloaded.", "configuration  ", "success"); }
      else if (result.status === "cancelled") emitLog("Setup cancelled. Keeping the current configuration.", "configuration  ", "warning");
      else emitLog(result.message, "configuration error  ", "error");
    }).catch((error: unknown) => { setupRunning = false; emitLog(getErrorMessage(error), "configuration error  ", "error"); });
  };
  const handleCommand = async (line: string): Promise<WebCommandResult> => {
    const words = line.split(/\s+/);
    const command = words[0];
    if (command === "/help") return { message: `${formatTuiCommandHelp()}\n\nEnter submits tasks. Prefix shell commands with !.` };
    if (command === "/config") return { message: `provider: ${active.configuration.provider}\nmodel: ${active.configuration.model}\neffort: ${active.configuration.effort}\nweb search: ${active.configuration.webSearch?.enabled ? "enabled" : "disabled"}` };
    if (command === "/reload") { const ok = await loadReplacement(); return { message: ok ? "Configuration reloaded." : "Reload failed.", tone: ok ? "success" : "error" }; }
    if (command === "/setup" || command === "/adapter") { if (words[1] !== undefined && words[1] !== "browser") return { message: "Usage: /setup [browser]", tone: "warning" }; runSetup(); return { message: "Browser setup opened.", tone: "text" }; }
    if (command === "/model") {
      const provider = PROVIDER_CATALOG.find((candidate) => candidate.id === active.configuration.provider && candidate.enabled) ?? PROVIDER_CATALOG[0];
      const requested = words[1];
      if (!provider.enabled) return { message: "The active provider is disabled.", tone: "error" };
      if (requested === undefined) return { message: `Models: ${provider.models.map((candidate) => candidate.id).join(", ")}` };
      const model = provider.models.find((candidate) => candidate.id === requested);
      if (model === undefined || words.length > 2) return { message: `Usage: /model <${provider.models.map((candidate) => candidate.id).join("|")}>`, tone: "warning" };
      await applySelection({ model: model.id }); return { message: `Model set to ${model.id}.`, tone: "success" };
    }
    if (command === "/effort") {
      const provider = PROVIDER_CATALOG.find((candidate) => candidate.id === active.configuration.provider && candidate.enabled) ?? PROVIDER_CATALOG[0];
      const requested = words[1];
      if (!provider.enabled) return { message: "The active provider is disabled.", tone: "error" };
      if (requested === undefined) return { message: `Efforts: ${provider.reasoningEfforts.map((candidate) => candidate.id).join(", ")}` };
      const effort = provider.reasoningEfforts.find((candidate) => candidate.id === requested);
      if (effort === undefined || words.length > 2) return { message: `Usage: /effort <${provider.reasoningEfforts.map((candidate) => candidate.id).join("|")}>`, tone: "warning" };
      await applySelection({ effort: effort.id }); return { message: `Reasoning effort set to ${effort.id}.`, tone: "success" };
    }
    if (command === "/reasoning") {
      if (words[1] !== undefined && words[1] !== "on" && words[1] !== "off") return { message: "Usage: /reasoning [on|off]", tone: "warning" };
      showingReasoning = words[1] === undefined ? !showingReasoning : words[1] === "on";
      return { message: `Recorded reasoning ${showingReasoning ? "enabled" : "disabled"}.`, tone: "success" };
    }
    if (command === "/replays") {
      const result = await listTraces(options.workspaceRoot);
      return result.ok ? { replays: result.traces, message: result.traces.length === 0 ? "No recorded runs." : "Recorded runs:" } : { message: result.error.message, tone: "error" };
    }
    if (command === "/replay") {
      if (words.length !== 2 || words[1] === undefined) return { message: "Usage: /replay <trace-id>", tone: "warning" };
      const replay = await replayTrace(options.workspaceRoot, words[1]);
      return { replay, message: replay.ok ? `Replay ${replay.traceId}` : replay.error.message, tone: replay.ok ? "text" : "error" };
    }
    if (command === "/clear" || command === "/new" || command === "/theme") return { message: `${command.slice(1)} is handled by the browser interface.` };
    return { message: `Unknown command: ${command ?? line}. Type /help for available commands.`, tone: "warning" };
  };
  const startTask = (task: string): void => {
    if (busy) { emitLog("itemD is already running a task.", "busy  ", "warning"); return; }
    busy = true; activeController = new AbortController(); emit({ type: "status", status: "running" }); emitState();
    const controller = activeController;
    void runAgent(task, active.adapter, options.workspaceRoot, {
      signal: controller.signal,
      tools: active.webSearchProvider === undefined ? {} : { webSearchProvider: active.webSearchProvider },
      onEvent: async (event: AgentRunEvent) => emit({ type: "reasoning", step: event.step, text: event.text }),
    }).then((result) => emit({ type: "run", result })).catch((error: unknown) => emitLog(getErrorMessage(error), "itemD error  ", "error")).finally(() => {
      if (activeController === controller) activeController = null;
      busy = false; emit({ type: "status", status: "ready" }); emitState();
    });
  };
  const startShell = (line: string): void => {
    if (busy) { emitLog("itemD is already busy.", "busy  ", "warning"); return; }
    busy = true; activeController = new AbortController(); emit({ type: "status", status: "running" }); emitState();
    const controller = activeController;
    void executePrefixedShellCommand(line.slice(1).trim(), options.workspaceRoot, controller.signal).then((result) => emitLog(formatShellResult(line.slice(1).trim(), result), "shell\n", result.ok ? "text" : "error")).catch((error: unknown) => emitLog(getErrorMessage(error), "shell error  ", "error")).finally(() => {
      if (activeController === controller) activeController = null;
      busy = false; emit({ type: "status", status: "ready" }); emitState();
    });
  };
  const logoBytes = logo;

  return new Promise((resolve, reject) => {
    let server: ReturnType<typeof createServer>;
    let settled = false;
    const close = (): void => {
      if (settled) return;
      settled = true;
      activeController?.abort();
      if (server.listening) { server.close(); server.closeAllConnections(); }
      resolve();
    };
    const authorize = (requestUrl: URL): boolean => requestUrl.searchParams.get("token") === token;
    server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", `http://${host}`);
      if (!authorize(requestUrl)) { sendJson(response, 403, { error: "Invalid web session" }); return; }
      if (requestUrl.pathname === "/" && request.method === "GET") { sendHtml(response, 200, pageHtml(token)); return; }
      if (requestUrl.pathname === "/assets/logo.png" && request.method === "GET") {
        if (logoBytes === null) { sendJson(response, 404, { error: "Logo unavailable" }); return; }
        response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" }); response.end(logoBytes); return;
      }
      try {
        if (requestUrl.pathname === "/api/state" && request.method === "GET") {
          const provider = PROVIDER_CATALOG.find((candidate) => candidate.id === active.configuration.provider && candidate.enabled) ?? PROVIDER_CATALOG[0];
          sendJson(response, 200, { state: configurationState(active, options.workspaceRoot, busy), models: provider.enabled ? provider.models : [], efforts: provider.enabled ? provider.reasoningEfforts : [] }); return;
        }
        if (requestUrl.pathname === "/api/events" && request.method === "GET") {
          const since = Number(requestUrl.searchParams.get("since") ?? "0"); sendJson(response, 200, { events: events.filter((event) => event.seq > since) }); return;
        }
        if (requestUrl.pathname === "/api/stop" && request.method === "POST") {
          if (activeController !== null) { emit({ type: "status", status: "stopping" }); activeController.abort(); }
          sendJson(response, 200, { ok: true }); return;
        }
        if (requestUrl.pathname === "/api/input" && request.method === "POST") {
          const value = JSON.parse(await readBody(request)) as unknown;
          const line = isRecord(value) && typeof value.line === "string" ? value.line.trim() : "";
          if (line.length === 0) { sendJson(response, 400, { message: "Input cannot be empty." }); return; }
          if (line.startsWith("!")) { startShell(line); sendJson(response, 202, { accepted: true }); return; }
          if (!line.startsWith("/")) { startTask(line); sendJson(response, 202, { accepted: true }); return; }
          const command = await handleCommand(line); sendJson(response, 200, command); return;
        }
        sendJson(response, 404, { error: "Not found" });
      } catch (error: unknown) { sendJson(response, 400, { message: getErrorMessage(error) }); }
    });
    server.once("error", reject);
    if (options.signal !== undefined) {
      if (options.signal.aborted) { close(); return; }
      options.signal.addEventListener("abort", close, { once: true });
    }
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      if (port === undefined) { reject(new Error("Unable to determine web UI address.")); return; }
      const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
      void openBrowser(url).catch(() => process.stdout.write(`itemD web UI: ${url}\n`));
    });
  });
}
