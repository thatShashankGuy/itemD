import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  runAgent,
  type AgentRunEvent,
  type AgentRunResult,
} from "../agent/runner.ts";
import type { AgentRuntimeEvent } from "../agent/events.ts";
import {
  readConfiguration,
  resolveConfiguration,
  writeConfiguration,
  type ConfigurationOptions,
  type ItemDConfiguration,
} from "../config/configuration.ts";
import { runBrowserSetup, openBrowserUrl } from "../config/browser-setup.ts";
import type { ModelAdapter } from "../model/adapter.ts";
import type { ModelMessage } from "../model/types.ts";
import { PROVIDER_CATALOG } from "../model/catalog.ts";
import { createModelAdapter } from "../model/factory.ts";
import { getErrorMessage, isRecord } from "../shared/runtime.ts";
import { listTraces, replayTrace, type ReplayResult } from "../telemetry/trace.ts";
import { executePrefixedShellCommand, formatShellResult } from "./shell.ts";
import { formatTuiCommandHelp } from "./commands.ts";
import type { SearchProvider } from "../web/provider.ts";
import { createSerperSearchProvider } from "../web/provider.ts";
import { SessionService, type SessionContext } from "../session/service.ts";
import { openSessionStore, type Session } from "../session/store.ts";

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
  | { seq: number; type: "activity"; phase: string; message: string; step?: number }
  | { seq: number; type: "status"; status: "ready" | "running" | "stopping" }
  | { seq: number; type: "state"; state: WebState }
  | { seq: number; type: "run"; result: AgentRunResult };

type WebEventInput =
  | { type: "log"; label: string; message: string; tone?: string }
  | { type: "reasoning"; step: number; text: string }
  | { type: "activity"; phase: string; message: string; step?: number }
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
  sessionDbPath?: string;
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
  sessions?: Session[];
  session?: Session;
  messages?: ModelMessage[];
};

function getWebSessionDbPath(options: WebOptions): string | undefined {
  if (options.sessionDbPath !== undefined) return options.sessionDbPath;
  if (options.config?.env?.ITEMD_SESSION_DB_PATH !== undefined) return undefined;
  if (options.config?.configPath !== undefined) {
    return join(dirname(resolve(options.config.configPath)), "sessions.db");
  }
  return undefined;
}

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
    :root { color-scheme: dark; --bg: #0d1117; --panel: #161b22; --panel-2: #1c2128; --text: #f0f3f6; --muted: #8b949e; --accent: #f04444; --success: #56d364; --warning: #e3b341; --error: #ff7b72; --user: #ff7b72; --scrim: rgb(0 0 0 / .55); }
    * { box-sizing: border-box; }
    [x-cloak] { display: none !important; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    button, input, select { font: inherit; }
    button { border: 0; border-radius: 5px; padding: .5rem .75rem; color: var(--text); background: var(--panel-2); cursor: pointer; }
    button:hover { color: var(--accent); }
    button.primary { color: white; background: var(--accent); }
    button.danger { color: var(--error); }
    body.light { --bg: #f6f8fa; --panel: #ffffff; --panel-2: #f0f2f4; --text: #1f2328; --muted: #59636e; --accent: #c62828; --success: #1a7f37; --warning: #9a6700; --error: #cf222e; --user: #b42318; --scrim: rgb(255 255 255 / .7); }
    .app { height: 100vh; min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
    header { display: flex; align-items: center; gap: .75rem; padding: .35rem .75rem; background: var(--bg); }
    #logo { width: 64px; height: 56px; object-fit: contain; image-rendering: pixelated; }
    .brand { min-width: 0; flex: 1; color: var(--accent); font-weight: 700; }
    .status { color: var(--success); white-space: nowrap; }
    .status.running { color: var(--warning); }
    main { min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; }
    .transcript { min-height: 0; overflow: auto; padding: .75rem 1rem; }
    .controls { min-width: 0; }
    .entry { margin-bottom: 1rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    .entry .label { color: var(--muted); margin-bottom: .2rem; }
    .entry.user .label { color: var(--user); }
    .entry.success .label { color: var(--success); }
    .entry.warning .label { color: var(--warning); }
    .entry.error .label { color: var(--error); }
    .entry.reasoning { color: var(--muted); }
    .activity { min-height: 1.8rem; padding: .35rem 1rem; color: var(--muted); background: var(--panel); }
    .approval { padding: .75rem 1rem; color: var(--warning); background: var(--panel); white-space: pre-wrap; }
    .composer { min-height: 20vh; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto minmax(0, 1fr); gap: .5rem; padding: .6rem .75rem; background: var(--panel); }
    .composer textarea, select { width: 100%; min-width: 0; border: 0; border-radius: 4px; padding: .55rem; color: var(--text); background: var(--bg); outline: 0; }
    .composer textarea { grid-column: 1; grid-row: 2; height: 100%; min-height: 0; resize: none; }
    .composer textarea:focus, select:focus { box-shadow: inset 0 -2px var(--accent); }
    .argument-helper { grid-column: 1 / -1; grid-row: 1; color: var(--muted); }
    .composer .danger { grid-column: 2; grid-row: 2; align-self: start; }
    .command-list { padding: .5rem 1rem; color: var(--text); background: var(--panel); white-space: pre-wrap; }
    .command-list .selected { color: var(--accent); }
    .picker-list { padding: .5rem 1rem; color: var(--text); background: var(--panel); white-space: pre-wrap; }
    .picker-list .selected { color: var(--accent); }
    footer { min-height: 1.8rem; display: flex; justify-content: space-between; gap: 1rem; padding: .35rem .75rem; color: var(--muted); background: var(--panel); }
    .disclaimer { color: var(--warning); }
    .empty { color: var(--muted); padding: 2rem 0; text-align: center; }
    .modal-backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 1rem; background: var(--scrim); }
    .modal { width: min(30rem, 100%); max-width: 30rem; padding: 1.25rem; background: var(--panel); box-shadow: 0 1rem 3rem rgb(0 0 0 / .35); }
    .modal h2 { margin: 0 0 1rem; color: var(--accent); }
    .modal label { display: block; margin: .8rem 0 .35rem; color: var(--muted); }
    .modal .value { color: var(--text); }
    .modal-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1.2rem; }
    @media (max-width: 600px) { .brand { display: none; } .composer { grid-template-columns: 1fr; } .composer textarea { grid-column: 1; } .composer .danger { grid-column: 1; grid-row: 3; justify-self: start; } }
  </style>
</head>
<body x-data="itemdApp()" :class="theme === 'light' ? 'light' : ''" @keydown.escape.window="handleEscape()">
<div class="app">
  <header>
    <img id="logo" src="/assets/logo.png?token=${encodeURIComponent(token)}" alt="itemD logo">
    <div class="brand">itemD</div>
    <button type="button" @click="configOpen = true">Configure</button>
    <div class="status" :class="{ running: busy }" x-text="status"></div>
  </header>
  <main>
    <section class="transcript" aria-live="polite" x-ref="transcript">
      <div class="empty" x-show="entries.length === 0">Type a coding task below, or use / for commands.</div>
      <template x-for="(entry, index) in entries" :key="index">
        <article class="entry" :class="entry.tone">
          <div class="label" x-text="entry.label"></div>
          <div x-text="entry.message"></div>
        </article>
      </template>
    </section>
    <div class="controls">
      <div class="activity" x-show="activity" x-text="activity" x-cloak></div>
      <div class="approval" x-show="approval" x-text="approval" x-cloak></div>
      <div class="picker-list" x-show="pickerItems.length > 0" x-cloak>
        <div class="label" x-text="pickerTitle"></div>
        <template x-for="(item, index) in pickerItems" :key="item.id">
          <div :class="{ selected: index === pickerIndex }" x-text="(index === pickerIndex ? '› ' : '  ') + item.label + '  ' + item.detail"></div>
        </template>
      </div>
      <div class="command-list" x-show="filteredCommands.length > 0" x-cloak>
        <template x-for="(command, index) in filteredCommands" :key="command.usage">
          <div :class="{ selected: index === selectedCommandIndex }" x-text="(index === selectedCommandIndex ? '› ' : '  ') + command.usage + '  ' + command.description"></div>
        </template>
      </div>
      <form class="composer" @submit.prevent="sendLine()">
        <div class="argument-helper" x-show="argumentHint" x-text="argumentHint" x-cloak></div>
        <textarea rows="1" autocomplete="off" :placeholder="inputPlaceholder" x-model="input" x-ref="input" @input="onInput()" @keydown="handleInputKeydown($event)"></textarea>
        <button class="danger" type="button" @click="stopTask()" x-show="busy">Stop</button>
      </form>
    </div>
  </main>
  <footer><span x-text="footer"></span><span class="disclaimer">Web view is experimental.</span></footer>
</div>
<div class="modal-backdrop" x-show="configOpen" x-cloak @click.self="configOpen = false">
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="config-title">
    <h2 id="config-title">Configuration</h2>
    <div class="value">Provider: <span x-text="state.provider || '—'"></span></div>
    <label for="config-model">Model</label>
    <select id="config-model" x-model="model">
      <template x-for="item in models" :key="item.id"><option :value="item.id" x-text="item.displayName"></option></template>
    </select>
    <label for="config-effort">Reasoning effort</label>
    <select id="config-effort" x-model="effort">
      <template x-for="item in efforts" :key="item.id"><option :value="item.id" x-text="item.displayName"></option></template>
    </select>
    <div class="value" style="margin-top:.8rem">Web search: <span x-text="state.webSearch ? 'enabled' : 'disabled'"></span></div>
    <div class="modal-actions">
      <button class="primary" type="button" @click="saveConfig()">Save</button>
      <button type="button" @click="openSetup()">Open key setup</button>
      <button type="button" @click="reloadConfig()">Reload</button>
      <button type="button" @click="toggleTheme()">Toggle theme</button>
      <button type="button" @click="configOpen = false">Close</button>
    </div>
  </section>
</div>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js"></script>
<script>
window.itemdApp = () => ({
  token: ${tokenJson}, sequence: 0, busy: false, status: 'READY', theme: 'dark',
  input: '', inputPlaceholder: 'Describe a task, type / for commands, or ! for shell', argumentHint: '', selectedCommandIndex: 0, pickerItems: [], pickerTitle: '', pickerIndex: 0, footer: 'Enter submits • Shift+Enter newline • / commands • ! shell', activity: '', approval: '',
  commands: [
    { usage: '/help', description: 'Show commands and keyboard controls', requiresArgument: false },
    { usage: '/config', description: 'Show active configuration', requiresArgument: false },
    { usage: '/model', description: 'Select or change the active model', requiresArgument: true, argumentHint: 'model: deepseek-flash | deepseek-v4-pro' },
    { usage: '/effort', description: 'Select reasoning effort', requiresArgument: true, argumentHint: 'effort: none | low | high | max' },
    { usage: '/reasoning', description: 'Toggle recorded reasoning', requiresArgument: false },
    { usage: '/reload', description: 'Reload configuration', requiresArgument: false },
    { usage: '/setup', description: 'Open key setup', requiresArgument: false },
    { usage: '/replays', description: 'List recorded runs', requiresArgument: false },
    { usage: '/replay', description: 'Display a recorded run', requiresArgument: true, argumentHint: 'trace id: paste a recorded trace id' },
    { usage: '/sessions', description: 'Browse recent sessions', requiresArgument: false },
    { usage: '/resume', description: 'Resume a session', requiresArgument: true, argumentHint: 'session id: choose from /sessions' },
    { usage: '/clear', description: 'Clear the transcript', requiresArgument: false },
    { usage: '/new', description: 'Start a new session', requiresArgument: false },
    { usage: '/theme', description: 'Switch light or dark theme', requiresArgument: false },
    { usage: '/exit', description: 'Exit itemD', requiresArgument: false },
  ],
  entries: [], showingReasoning: false, configOpen: false, models: [], efforts: [], model: '', effort: '',
  state: { provider: '', model: '', effort: '', webSearch: false, workspace: '', busy: false }, timer: null,
  get filteredCommands() {
    const prefix = this.input.trimStart();
    if (!prefix.startsWith('/') || /\s/.test(prefix)) return [];
    return this.commands.filter((command) => command.usage.startsWith(prefix.toLowerCase()));
  },
  onInput() {
    this.selectedCommandIndex = 0;
    if (!this.input.trim().startsWith('/')) this.argumentHint = '';
  },
  prepareCommand(command) {
    this.input = command.usage + (command.requiresArgument ? ' ' : '');
    this.argumentHint = command.requiresArgument ? command.argumentHint : '';
  },
  openPicker(title, items) {
    this.pickerTitle = title;
    this.pickerItems = items;
    this.pickerIndex = 0;
    this.argumentHint = '';
    this.footer = '↑/↓ select • Enter choose • Esc close';
  },
  closePicker() {
    this.pickerItems = [];
    this.pickerTitle = '';
    this.pickerIndex = 0;
    this.footer = 'Enter submits • Shift+Enter newline • / commands • ! shell';
  },
  async selectPickerItem() {
    const item = this.pickerItems[this.pickerIndex];
    if (!item) return;
    this.closePicker();
    this.input = item.action + ' ' + item.id;
    await this.sendLine();
  },
  handleInputKeydown(event) {
    if (this.pickerItems.length > 0) {
      if (event.key === 'Escape') { event.preventDefault(); this.closePicker(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); this.pickerIndex = (this.pickerIndex + 1) % this.pickerItems.length; return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); this.pickerIndex = (this.pickerIndex - 1 + this.pickerItems.length) % this.pickerItems.length; return; }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void this.selectPickerItem(); return; }
      return;
    }
    if (event.key === 'Enter') {
      if (event.shiftKey) return;
      event.preventDefault();
      void this.sendLine();
      return;
    }
    if (event.key === 'ArrowDown' && this.filteredCommands.length > 0) {
      event.preventDefault();
      this.selectedCommandIndex = (this.selectedCommandIndex + 1) % this.filteredCommands.length;
      return;
    }
    if (event.key === 'ArrowUp' && this.filteredCommands.length > 0) {
      event.preventDefault();
      this.selectedCommandIndex = (this.selectedCommandIndex - 1 + this.filteredCommands.length) % this.filteredCommands.length;
      return;
    }
    if (event.key === 'Tab' && this.filteredCommands.length > 0) {
      event.preventDefault();
      const command = this.filteredCommands[this.selectedCommandIndex];
      this.prepareCommand(command);
    }
  },
  async api(path, options = {}) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(path + separator + 'token=' + encodeURIComponent(this.token), {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || value.error || 'Request failed');
    return value;
  },
  addEntry(label, message, tone = 'text') {
    this.entries.push({ label, message, tone });
    this.$nextTick(() => { this.$refs.transcript.scrollTop = this.$refs.transcript.scrollHeight; });
  },
  setState(state) {
    this.state = state;
    this.busy = state.busy;
    this.status = this.busy ? 'RUNNING' : 'READY';
    if (!this.busy) { this.activity = ''; this.approval = ''; }
  },
  applyEvents(events) {
    events.forEach((event) => {
      this.sequence = Math.max(this.sequence, event.seq || this.sequence);
      if (event.type === 'log') this.addEntry(event.label, event.message, event.tone || 'text');
      if (event.type === 'reasoning' && this.showingReasoning) this.addEntry('reasoning step ' + event.step, event.text, 'reasoning');
      if (event.type === 'activity') this.activity = (event.step === undefined ? '' : 'step ' + event.step + ' • ') + event.phase + ' • ' + event.message;
      if (event.type === 'status') { this.busy = event.status !== 'ready'; this.status = event.status.toUpperCase(); if (!this.busy) this.activity = ''; }
      if (event.type === 'state') this.setState(event.state);
      if (event.type === 'run') {
        const result = event.result;
        this.addEntry(result.ok ? 'done' : result.status, result.ok ? result.answer : result.error.message, result.ok ? 'success' : 'error');
        this.addEntry('run', result.steps + ' step' + (result.steps === 1 ? '' : 's') + ' • trace ' + result.traceId);
      }
    });
  },
  async refresh() {
    try { this.applyEvents((await this.api('/api/events?since=' + this.sequence)).events || []); }
    catch (error) { this.footer = 'Connection error: ' + error.message; }
  },
  async submitCommand(line) {
    const result = await this.api('/api/input', { method: 'POST', body: JSON.stringify({ line }) });
    if (result.message) this.addEntry('itemD', result.message, result.tone || 'text');
    if (result.replays) this.openPicker('Recorded runs', result.replays.map((replay) => ({ id: replay.traceId, action: '/replay', label: replay.traceId, detail: replay.modifiedAt })));
    if (result.sessions) this.openPicker('Recent sessions', result.sessions.map((session) => ({ id: session.id, action: '/resume', label: session.id.slice(0, 8), detail: session.updatedAt })));
    if (result.messages && result.session) {
      this.entries = [];
      this.addEntry('history', 'Restored session history');
      result.messages.forEach((message) => {
        const label = message.role === 'user' ? 'you' : message.role === 'tool' ? 'tool' : 'assistant';
        const text = message.role === 'assistant' && message.content === null ? '(empty assistant message)' : message.content;
        this.addEntry(label, text, label === 'you' ? 'user' : label === 'assistant' ? 'text' : 'reasoning');
      });
    }
    if (result.replay && result.replay.ok) this.addEntry('replay ' + result.replay.traceId, JSON.stringify(result.replay.events, null, 2));
  },
  async sendLine() {
    const line = this.input.trim();
    if (!line || this.busy) return;
    const command = this.commands.find((candidate) => candidate.usage === line);
    if (line.startsWith('/') && command === undefined && this.filteredCommands.length > 0) {
      this.prepareCommand(this.filteredCommands[this.selectedCommandIndex]);
      return;
    }
    if (command?.requiresArgument) {
      this.prepareCommand(command);
      return;
    }
    if (line === '/clear') {
      this.entries = [];
      this.addEntry('', 'Transcript cleared.');
      this.input = ''; this.argumentHint = '';
      return;
    }
    if (line === '/new') {
      this.entries = [];
      this.input = ''; this.argumentHint = '';
      try { await this.submitCommand(line); }
      catch (error) { this.addEntry('error', error.message, 'error'); }
      return;
    }
    if (line === '$editor') {
      this.input = ''; this.argumentHint = '';
      try { await this.submitCommand(line); }
      catch (error) { this.addEntry('error', error.message, 'error'); }
      return;
    }
    if (line === '/theme' || line === '/theme light' || line === '/theme dark') {
      this.theme = line === '/theme light' ? 'light' : line === '/theme dark' ? 'dark' : this.theme === 'dark' ? 'light' : 'dark';
      this.input = ''; this.argumentHint = '';
      return;
    }
    if (line === '/reasoning on') this.showingReasoning = true;
    if (line === '/reasoning off') this.showingReasoning = false;
    this.addEntry(line.startsWith('!') ? 'shell' : line.startsWith('/') ? 'command' : 'you', line, line.startsWith('/') ? 'text' : 'user');
    this.input = ''; this.argumentHint = '';
    try { await this.submitCommand(line); }
    catch (error) { this.addEntry('error', error.message, 'error'); }
  },
  handleEscape() {
    if (this.pickerItems.length > 0) { this.closePicker(); return; }
    if (this.busy) { void this.stopTask(); return; }
    this.configOpen = false;
  },
  async stopTask() {
    this.status = 'STOPPING'; this.footer = 'Stopping…';
    try { await this.api('/api/stop', { method: 'POST', body: '{}' }); }
    catch (error) { this.addEntry('error', error.message, 'error'); }
  },
  async saveConfig() {
    try {
      if (this.model) await this.submitCommand('/model ' + this.model);
      if (this.effort) await this.submitCommand('/effort ' + this.effort);
      this.configOpen = false;
    } catch (error) { this.addEntry('configuration error', error.message, 'error'); }
  },
  async openSetup() { this.configOpen = false; try { await this.submitCommand('/setup browser ' + this.theme); } catch (error) { this.addEntry('configuration error', error.message, 'error'); } },
  async reloadConfig() { try { await this.submitCommand('/reload'); } catch (error) { this.addEntry('configuration error', error.message, 'error'); } },
  toggleTheme() { this.theme = this.theme === 'dark' ? 'light' : 'dark'; },
  async init() {
    try {
      const data = await this.api('/api/state');
      this.setState(data.state); this.models = data.models; this.efforts = data.efforts; this.model = data.state.model; this.effort = data.state.effort;
      this.addEntry('', 'itemD is ready. Type a task below, / for commands, or ! for shell.');
      await this.refresh(); this.timer = setInterval(() => void this.refresh(), 500); this.$refs.input.focus();
    } catch (error) { this.addEntry('error', error.message, 'error'); }
  },
});
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
  const sessionDbPath = getWebSessionDbPath(options);
  const sessionStore = await openSessionStore({
    ...(sessionDbPath === undefined ? {} : { dbPath: sessionDbPath }),
    ...(options.config?.env === undefined ? {} : { env: options.config.env }),
  });
  const sessionService = new SessionService(sessionStore);
  let sessionContext: SessionContext = sessionService.createSession(options.workspaceRoot);
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
  const runSetup = (theme: "dark" | "light" = "dark"): void => {
    if (setupRunning) { emitLog("Browser setup is already open.", "configuration  ", "warning"); return; }
    setupRunning = true;
    emitLog("Browser setup opened. Return here after saving.", "configuration  ", "text");
    const setupOptions = {
      config,
      initialConfiguration: active.configuration,
      theme,
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
    if (command === "/setup" || command === "/adapter") {
      if (words[1] !== undefined && words[1] !== "browser") return { message: "Usage: /setup [browser]", tone: "warning" };
      const requestedTheme = words[2] === "light" || words[2] === "dark" ? words[2] : "dark";
      if (words.length > 3 || (words[2] !== undefined && words[2] !== "light" && words[2] !== "dark")) return { message: "Usage: /setup browser [dark|light]", tone: "warning" };
      runSetup(requestedTheme); return { message: "Browser setup opened.", tone: "text" };
    }
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
    if (command === "/sessions") {
      const sessions = sessionService.listSessions(10).filter((session) => session.workspaceRoot === options.workspaceRoot);
      return { sessions, message: sessions.length === 0 ? "No saved sessions." : "Select a session:" };
    }
    if (command === "/resume") {
      if (words.length !== 2 || words[1] === undefined) return { message: "Usage: /resume <session-id>", tone: "warning" };
      const resumed = sessionService.resumeSession(words[1], options.workspaceRoot);
      if (!resumed.ok) return { message: resumed.error.message, tone: "error" };
      sessionContext = resumed.context;
      return { session: resumed.context.session, messages: resumed.context.messages, message: "Session resumed." };
    }
    if (command === "/new") {
      sessionContext = sessionService.createSession(options.workspaceRoot);
      return { message: "New session started. Active configuration retained.", tone: "success" };
    }
    if (command === "/clear" || command === "/theme") return { message: `${command.slice(1)} is handled by the browser interface.` };
    return { message: `Unknown command: ${command ?? line}. Type /help for available commands.`, tone: "warning" };
  };
  const startTask = (task: string): void => {
    if (busy) { emitLog("itemD is already running a task.", "busy  ", "warning"); return; }
    sessionContext = sessionService.appendMessage(sessionContext.session.id, { role: "user", content: task });
    busy = true; activeController = new AbortController(); emit({ type: "status", status: "running" }); emitState();
    const controller = activeController;
    void runAgent(task, active.adapter, options.workspaceRoot, {
      signal: controller.signal,
      tools: active.webSearchProvider === undefined ? {} : { webSearchProvider: active.webSearchProvider },
      initialMessages: sessionContext.messages,
      onMessage: (message: ModelMessage): void => {
        sessionContext = sessionService.appendMessage(sessionContext.session.id, message);
      },
      onEvent: async (event: AgentRunEvent) => emit({ type: "reasoning", step: event.step, text: event.text }),
      onRuntimeEvent: (event: AgentRuntimeEvent): void => {
        if (event.type === "activity") {
          emit({
            type: "activity",
            phase: event.phase,
            message: event.message,
            ...(event.step === undefined ? {} : { step: event.step }),
          });
        } else if (event.type === "tool_started") {
          emit({
            type: "activity",
            phase: "tool_started",
            message: event.toolName,
            step: event.step,
          });
        } else if (event.type === "tool_finished") {
          emit({
            type: "activity",
            phase: event.result.ok ? "tool_finished" : "tool_failed",
            message: event.toolName,
            step: event.step,
          });
        }
      },
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
      sessionService.close();
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
          if (line === "$editor") { sendJson(response, 200, { message: "$editor is available only in the terminal composer. Use the terminal interface to open your local editor.", tone: "warning" }); return; }
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
