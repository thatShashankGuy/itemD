import { basename, dirname, join, resolve } from "node:path";
import {
  ASCIIFontRenderable,
  BoxRenderable,
  CliRenderEvents,
  ImageRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  createClipboard,
  createCliRenderer,
  createHostClipboard,
  createRendererClipboardAdapter,
  type ClipboardService,
  type KeyEvent,
  type Selection,
} from "@opentui/core";
import {
  runAgent,
  type AgentRunEvent,
} from "../agent/runner.ts";
import type { AgentRuntimeEvent } from "../agent/events.ts";
import {
  resolveConfiguration,
  readConfiguration,
  writeConfiguration,
  type ConfigurationOptions,
  type ItemDConfiguration,
} from "../config/configuration.ts";
import { runBrowserSetup } from "../config/browser-setup.ts";
import type { ModelAdapter } from "../model/adapter.ts";
import type { ModelMessage } from "../model/types.ts";
import { PROVIDER_CATALOG } from "../model/catalog.ts";
import { createModelAdapter } from "../model/factory.ts";
import {
  getErrorMessage,
  isRecord,
  isStandaloneExecutable,
} from "../shared/runtime.ts";
import { createSerperSearchProvider } from "../web/provider.ts";
import type { SearchProvider } from "../web/provider.ts";
import {
  SessionService,
  type SessionContext,
} from "../session/service.ts";
import type { Session } from "../session/store.ts";
import { presentSessionMessage } from "../session/presentation.ts";
import { openSessionStore } from "../session/store.ts";
import {
  ShellApprovalController,
  type ShellApprovalDecision,
  type ShellApprovalRequest,
  type ShellExecutionMode,
} from "../permissions/shell-approval.ts";
import { listTraces, replayTrace } from "../telemetry/trace.ts";
import {
  formatTuiCommandHelp,
  suggestTuiCommands,
  type TuiCommand,
} from "./commands.ts";
import {
  copiedCharactersMessage,
  getTranscriptSelectionText,
  LOADER_FRAMES,
} from "./feedback.ts";
import {
  executePrefixedShellCommand,
  formatShellResult,
} from "./shell.ts";
import {
  formatActivitySnapshot,
  formatShellApprovalPanel,
} from "./opentui-activity.ts";

type ThemeName = "dark" | "light";

type UiTheme = {
  name: ThemeName;
  background: string;
  panel: string;
  accent: string;
  text: string;
  muted: string;
  success: string;
  warning: string;
  error: string;
  user: string;
  selectionBackground: string;
  selectionText: string;
};

const DARK_THEME: UiTheme = {
  name: "dark",
  background: "#0d1117",
  panel: "#161b22",
  accent: "#f04444",
  text: "#f0f3f6",
  muted: "#8b949e",
  success: "#56d364",
  warning: "#e3b341",
  error: "#ff7b72",
  user: "#ff7b72",
  selectionBackground: "#6e1f25",
  selectionText: "#fff1f1",
};

const LIGHT_THEME: UiTheme = {
  name: "light",
  background: "#f6f8fa",
  panel: "#ffffff",
  accent: "#c62828",
  text: "#1f2328",
  muted: "#59636e",
  success: "#1a7f37",
  warning: "#9a6700",
  error: "#cf222e",
  user: "#b42318",
  selectionBackground: "#ffd7d9",
  selectionText: "#5c0010",
};

let COLORS: UiTheme = DARK_THEME;

type LogColorRole =
  | "text"
  | "muted"
  | "success"
  | "warning"
  | "error"
  | "user";

const LOG_COLOR_ROLES: readonly LogColorRole[] = [
  "text",
  "muted",
  "success",
  "warning",
  "error",
  "user",
];

function getLogColorRole(theme: UiTheme, color: string): LogColorRole {
  return (
    LOG_COLOR_ROLES.find((role) => theme[role] === color) ?? "text"
  );
}

const DEFAULT_FOOTER_TEXT =
  " PgUp/PgDn scroll  •  mouse drag copies  •  Esc stops task  •  Ctrl+C exits ";
const KEYBOARD_HELP =
  "Keys\n" +
  "Esc             Stop the active agent task\n" +
  "!<command>      Run a command through the shell policy\n" +
  "PgUp/PgDn      Scroll the transcript\n" +
  "Ctrl+Up/Down   Fine-scroll the transcript\n" +
  "Mouse drag     Select and copy transcript text\n" +
  "Ctrl+C         Exit itemD";

const LOGO_ASSET_NAME = "Just_One_More_Commit.png";
const MAX_REPLAY_CHOICES = 12;
const REPLAY_EVENT_DELAY_MS = 120;
const MAX_REPLAY_EVENT_CHARS = 20_000;

function formatReplayJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function trimReplayText(value: string): string {
  return value.length <= MAX_REPLAY_EVENT_CHARS
    ? value
    : `${value.slice(0, MAX_REPLAY_EVENT_CHARS)}\n[…replay event truncated]`;
}

function formatReplayEvent(
  event: unknown,
  includeReasoning: boolean,
): string {
  if (!isRecord(event) || typeof event.type !== "string") {
    return trimReplayText(formatReplayJson(event));
  }

  if (event.type === "run_start") {
    return [
      `task: ${typeof event.task === "string" ? event.task : "unknown"}`,
      `model: ${String(event.provider ?? "unknown")} / ${String(event.model ?? "unknown")} (${String(event.effort ?? "unknown")})`,
      `step limit: ${String(event.maxSteps ?? "unknown")}`,
    ].join("\n");
  }

  if (event.type === "model_call") {
    const result = isRecord(event.result) ? event.result : undefined;
    const message =
      result !== undefined && isRecord(result.message)
        ? result.message
        : undefined;
    const lines = [
      `step ${String(event.step ?? "?")} • model call • ${String(event.durationMs ?? "?")}ms`,
    ];

    if (message !== undefined && typeof message.reasoning === "string") {
      lines.push(
        includeReasoning
          ? `reasoning:\n${message.reasoning}`
          : "reasoning hidden — use /reasoning on to show it",
      );
    }

    const action = result !== undefined && isRecord(result.action)
      ? result.action
      : undefined;

    if (action?.type === "final" && typeof action.text === "string") {
      lines.push(`response:\n${action.text}`);
    } else if (action?.type === "tool_calls" && Array.isArray(action.calls)) {
      const names = action.calls
        .filter(isRecord)
        .map((call) => String(call.name ?? "unknown"))
        .join(", ");
      lines.push(`tools requested: ${names || "unknown"}`);
    }

    return trimReplayText(lines.join("\n"));
  }

  if (event.type === "tool_call") {
    const request = isRecord(event.request) ? event.request : undefined;
    return trimReplayText(
      [
        `step ${String(event.step ?? "?")} • tool call • ${String(event.durationMs ?? "?")}ms`,
        `tool: ${String(request?.type ?? request?.name ?? "unknown")}`,
        `result:\n${formatReplayJson(event.result)}`,
      ].join("\n"),
    );
  }

  if (event.type === "activity") {
    return `step ${String(event.step ?? "?")} • ${String(event.phase ?? "activity")} • ${String(event.message ?? "")}`;
  }

  if (event.type === "run_end") {
    return trimReplayText(`run complete\n${formatReplayJson(event.result)}`);
  }

  return trimReplayText(formatReplayJson(event));
}

function logoSource(): URL | Blob {
  const bun = (
    globalThis as {
      Bun?: {
        embeddedFiles?: readonly (Blob & { name?: string })[];
      };
    }
  ).Bun;
  const embeddedLogo = bun?.embeddedFiles?.find((file) =>
    file.name?.includes(LOGO_ASSET_NAME),
  );

  if (embeddedLogo !== undefined) {
    return embeddedLogo;
  }

  const assetPath = isStandaloneExecutable()
    ? `assets/${LOGO_ASSET_NAME}`
    : `../../assets/${LOGO_ASSET_NAME}`;

  return new URL(assetPath, import.meta.url);
}

type OpenTuiOptions = {
  resumeSessionId?: string;
  sessionDbPath?: string;
  shellMode?: ShellExecutionMode;
  workspaceRoot: string;
  config: ConfigurationOptions;
};

function getOpenTuiSessionDbPath(
  options: OpenTuiOptions,
): string | undefined {
  if (options.sessionDbPath !== undefined) {
    return options.sessionDbPath;
  }

  if (options.config.env?.ITEMD_SESSION_DB_PATH !== undefined) {
    return undefined;
  }

  if (options.config.configPath !== undefined) {
    return join(
      dirname(resolve(options.config.configPath)),
      "sessions.db",
    );
  }

  return undefined;
}

function parseShellApprovalDecision(value: string): ShellApprovalDecision | null {
  const choice = value.trim().toLowerCase();

  if (choice === "1" || choice === "once" || choice === "y") {
    return "once";
  }

  if (choice === "2" || choice === "always" || choice === "a") {
    return "always";
  }

  if (choice === "3" || choice === "deny" || choice === "n") {
    return "deny";
  }

  return null;
}

type ActiveConfiguration = {
  configuration: ItemDConfiguration;
  adapter: ModelAdapter;
  webSearchProvider?: SearchProvider;
};

function createActiveConfiguration(
  configuration: ItemDConfiguration,
): { ok: true; active: ActiveConfiguration } | { ok: false; message: string } {
  const adapterResult = createModelAdapter(configuration);

  if (!adapterResult.ok) {
    return { ok: false, message: adapterResult.error.message };
  }

  const webSearchProvider = configuration.webSearch?.enabled === true
    ? createSerperSearchProvider({
        apiKey: configuration.webSearch.serperApiKey,
      })
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
): Promise<
  | { ok: true; active: ActiveConfiguration }
  | { ok: false; message: string }
> {
  const result = await resolveConfiguration(config);

  if (!result.ok) {
    return { ok: false, message: result.error.message };
  }

  if (result.configuration === null) {
    return {
      ok: false,
      message: "No usable model configuration was found.",
    };
  }

  return createActiveConfiguration(result.configuration);
}

async function runInitialSetup(
  config: ConfigurationOptions,
): Promise<ActiveConfiguration | null> {
  const existing = await loadActiveConfiguration(config);

  if (existing.ok) {
    return existing.active;
  }

  const result = await runBrowserSetup({ config });

  if (result.status !== "saved") {
    process.stderr.write(`[configuration] ${result.status === "failed" ? result.message : "Setup cancelled."}\n`);
    return null;
  }

  const configured = await loadActiveConfiguration(config);

  if (!configured.ok) {
    process.stderr.write(`[configuration error] ${configured.message}\n`);
    return null;
  }

  return configured.active;
}

function configurationText(active: ActiveConfiguration): string {
  const { provider, model, effort, webSearch } = active.configuration;
  return [
    `provider: ${provider}`,
    `model: ${model}`,
    `effort: ${effort}`,
    `web search: ${webSearch?.enabled ? "enabled" : "disabled"}`,
  ].join("\n");
}

export async function runOpenTui(options: OpenTuiOptions): Promise<void> {
  COLORS = DARK_THEME;
  const initialActive = await runInitialSetup(options.config);

  if (initialActive === null) {
    return;
  }

  const sessionDbPath = getOpenTuiSessionDbPath(options);
  const sessionStore = await openSessionStore({
    ...(sessionDbPath === undefined
      ? {}
      : { dbPath: sessionDbPath }),
    ...(options.config.env === undefined ? {} : { env: options.config.env }),
  });
  const sessionService = new SessionService(sessionStore);
  let sessionContext: SessionContext;

  if (options.resumeSessionId !== undefined) {
    const resumed = sessionService.resumeSession(
      options.resumeSessionId,
      options.workspaceRoot,
    );

    if (!resumed.ok) {
      sessionService.close();
      process.stderr.write(`[session error] ${resumed.error.message}\n`);
      return;
    }

    sessionContext = resumed.context;
  } else {
    sessionContext = sessionService.createSession(options.workspaceRoot);
  }

  let active: ActiveConfiguration = initialActive;

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    backgroundColor: COLORS.background,
    consoleMode: "disabled",
    openConsoleOnError: false,
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: true,
    targetFps: 30,
  });
  let clipboard: ClipboardService | null = null;

  try {
    const host = createHostClipboard();

    try {
      clipboard = createClipboard({
        host,
        terminal: createRendererClipboardAdapter(renderer),
      });
    } catch (error: unknown) {
      await host.dispose();
      throw error;
    }
  } catch {
    // OSC 52 remains available as a fallback when host clipboard setup fails.
  }

  const app = new BoxRenderable(renderer, {
    id: "itemd-app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLORS.background,
  });
  const header = new BoxRenderable(renderer, {
    id: "header",
    width: "100%",
    height: 3,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingX: 1,
    columnGap: 1,
    backgroundColor: COLORS.background,
  });
  const logoFallback = new ASCIIFontRenderable(renderer, {
    id: "logo-fallback",
    text: "itemD",
    font: "tiny",
    color: COLORS.accent,
    selectable: false,
    flexShrink: 0,
    visible: false,
  });
  const logo = new ImageRenderable(renderer, {
    id: "logo",
    source: logoSource(),
    width: 8,
    height: 3,
    fit: "fill",
    flexShrink: 0,
    onError: () => {
      logo.visible = false;
      logoFallback.visible = true;
    },
  });
  const statusText = new TextRenderable(renderer, {
    id: "status",
    content: "READY",
    fg: COLORS.success,
    flexShrink: 0,
  });
  header.add(logo);
  header.add(logoFallback);
  const headerSpacer = new BoxRenderable(renderer, {
    id: "header-spacer",
    flexGrow: 1,
  });
  header.add(headerSpacer);
  header.add(statusText);

  const body = new BoxRenderable(renderer, {
    id: "body",
    width: "100%",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 1,
    flexDirection: "column",
    backgroundColor: COLORS.background,
  });

  const mainColumn = new BoxRenderable(renderer, {
    id: "main-column",
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 1,
    flexDirection: "column",
    backgroundColor: COLORS.background,
  });

  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    width: "100%",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
    viewportCulling: true,
    viewportOptions: {
      backgroundColor: COLORS.background,
      paddingLeft: 1,
      paddingRight: 1,
    },
    contentOptions: {
      flexDirection: "column",
    },
    verticalScrollbarOptions: {
      trackOptions: {
        foregroundColor: COLORS.accent,
        backgroundColor: COLORS.panel,
      },
    },
  });
  const activityBox = new BoxRenderable(renderer, {
    id: "activity",
    width: "100%",
    height: 3,
    flexShrink: 0,
    paddingX: 1,
    visible: false,
    backgroundColor: COLORS.panel,
  });
  const activityText = new TextRenderable(renderer, {
    id: "activity-text",
    content: "",
    width: "100%",
    fg: COLORS.muted,
    wrapMode: "word",
  });
  activityBox.add(activityText);
  const approvalPanel = new BoxRenderable(renderer, {
    id: "shell-approval",
    width: "100%",
    height: 6,
    flexShrink: 0,
    paddingX: 1,
    visible: false,
    backgroundColor: COLORS.panel,
  });
  const approvalText = new TextRenderable(renderer, {
    id: "shell-approval-text",
    content: "",
    width: "100%",
    fg: COLORS.warning,
    wrapMode: "word",
  });
  approvalPanel.add(approvalText);
  const commandPalette = new BoxRenderable(renderer, {
    id: "command-palette",
    width: "100%",
    height: 3,
    flexShrink: 0,
    paddingX: 1,
    visible: false,
    backgroundColor: COLORS.panel,
  });
  const commandPaletteText = new TextRenderable(renderer, {
    id: "command-palette-text",
    content: "",
    width: "100%",
    fg: COLORS.text,
    selectionBg: COLORS.selectionBackground,
    selectionFg: COLORS.selectionText,
    wrapMode: "none",
  });
  commandPalette.add(commandPaletteText);

  const inputBox = new BoxRenderable(renderer, {
    id: "task-input-box",
    width: "100%",
    height: 3,
    flexShrink: 0,
    paddingX: 1,
    backgroundColor: COLORS.panel,
  });
  const taskInput = new InputRenderable(renderer, {
    id: "task-input",
    width: "100%",
    value: "",
    placeholder: "Describe a task or type / for commands",
    backgroundColor: COLORS.panel,
    focusedBackgroundColor: COLORS.panel,
    textColor: COLORS.text,
    focusedTextColor: COLORS.text,
    placeholderColor: COLORS.muted,
    cursorColor: COLORS.accent,
    selectionBg: COLORS.selectionBackground,
    selectionFg: COLORS.selectionText,
  });
  inputBox.add(taskInput);

  const footer = new TextRenderable(renderer, {
    id: "footer",
    width: "100%",
    height: 1,
    flexShrink: 0,
    content: DEFAULT_FOOTER_TEXT,
    fg: COLORS.muted,
    bg: COLORS.panel,
    wrapMode: "none",
  });

  body.add(mainColumn);
  mainColumn.add(transcript);
  mainColumn.add(activityBox);
  mainColumn.add(approvalPanel);
  mainColumn.add(commandPalette);
  mainColumn.add(inputBox);
  app.add(header);
  app.add(body);
  app.add(footer);
  renderer.root.add(app);

  let selectedCommandIndex = 0;
  let visibleCommands: readonly TuiCommand[] = [];
  let busy = false;
  let activeRunController: AbortController | null = null;
  let activeReplayController: AbortController | null = null;
  let activeSetupController: AbortController | null = null;
  let replayPickerVisible = false;
  let sessionPickerVisible = false;
  type ConfigurationMenu =
    | { level: "root" }
    | { level: "model" }
    | { level: "effort" };
  let configurationMenu: ConfigurationMenu | null = null;
  let configurationChoices: Array<{ label: string; detail: string }> = [];
  let selectedConfigurationIndex = 0;
  let replayChoices: Array<{
    traceId: string;
    modifiedAt: string;
  }> = [];
  let selectedReplayIndex = 0;
  let sessionChoices: Session[] = [];
  let selectedSessionIndex = 0;
  let streamReasoning = false;
  let stopLoaderTick: (() => void) | null = null;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingShellApproval:
    | {
        resolve: (decision: ShellApprovalDecision) => void;
        cleanup: () => void;
      }
    | null = null;
  const transcriptEntries: Array<{
    renderable: TextRenderable;
    colorRole: LogColorRole;
  }> = [];

  const stopLoader = (): void => {
    stopLoaderTick?.();
    stopLoaderTick = null;
  };

  const stopElapsedTimer = (): void => {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  };

  const formatElapsed = (startedAt: number): string => {
    const seconds = Math.floor((Date.now() - startedAt) / 1_000);
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };

  const startElapsedTimer = (label: string): void => {
    stopElapsedTimer();
    const startedAt = Date.now();
    const update = (): void => {
      if (!renderer.isDestroyed) {
        footer.content = ` ${label} ${formatElapsed(startedAt)}`;
        footer.fg = COLORS.muted;
      }
    };

    update();
    elapsedTimer = setInterval(update, 1_000);
  };

  const startLoader = (): void => {
    stopLoader();
    let frameIndex = 0;
    statusText.content = `${LOADER_FRAMES[frameIndex]} RUNNING`;
    stopLoaderTick = renderer.onAnimationTick(
      10,
      (_deltaTime, ticks) => {
        frameIndex = (frameIndex + ticks) % LOADER_FRAMES.length;
        statusText.content = `${LOADER_FRAMES[frameIndex]} RUNNING`;
      },
    );
  };

  const showToast = (
    message: string,
    color: string = COLORS.success,
  ): void => {
    if (renderer.isDestroyed) {
      return;
    }

    if (toastTimer !== null) {
      clearTimeout(toastTimer);
    }

    footer.content = ` ${message}`;
    footer.fg = color;
    toastTimer = setTimeout(() => {
      toastTimer = null;

      if (!renderer.isDestroyed) {
        footer.content = DEFAULT_FOOTER_TEXT;
        footer.fg = COLORS.muted;
      }
    }, 1_800);
  };

  const updateActivity = (content: string, visible = true): void => {
    activityText.content = content;
    activityBox.visible = visible;
  };

  const appendLog = (
    label: string,
    message: string,
    color: string = COLORS.text,
  ): TextRenderable => {
    const colorRole = getLogColorRole(COLORS, color);
    const entry = new TextRenderable(renderer, {
      content: `${label}${message}`,
      width: "100%",
      flexShrink: 0,
      fg: COLORS[colorRole],
      selectionBg: COLORS.selectionBackground,
      selectionFg: COLORS.selectionText,
      wrapMode: "word",
      marginBottom: 1,
    });
    transcriptEntries.push({ renderable: entry, colorRole });
    transcript.add(entry);
    transcript.scrollTo(Infinity);
    return entry;
  };

  let liveAssistantEntry: TextRenderable | null = null;
  let liveAssistantStep: number | null = null;
  let liveAssistantText = "";

  const resetLiveAssistant = (): void => {
    liveAssistantEntry = null;
    liveAssistantStep = null;
    liveAssistantText = "";
  };

  const appendModelDelta = (step: number, text: string): void => {
    if (liveAssistantEntry === null || liveAssistantStep !== step) {
      liveAssistantStep = step;
      liveAssistantText = "";
      liveAssistantEntry = appendLog(
        `assistant step ${step}\n`,
        "",
        COLORS.text,
      );
    }

    liveAssistantText += text;
    liveAssistantEntry.content =
      `assistant step ${step}\n${liveAssistantText}`;
    transcript.scrollTo(Infinity);
  };

  const handleRuntimeEvent = (event: AgentRuntimeEvent): void => {
    if (event.type === "model_delta") {
      appendModelDelta(event.step, event.text);
      return;
    }

    if (event.type === "activity") {
      updateActivity(formatActivitySnapshot({
        phase: event.phase,
        message: event.message,
        ...(event.step === undefined ? {} : { step: event.step }),
      }));
      if (event.phase === "executing_tool") {
        footer.content = ` ${event.message}`;
        footer.fg = COLORS.muted;
      }
      return;
    }

    if (event.type === "tool_started") {
      updateActivity(formatActivitySnapshot({
        phase: "tool_started",
        message: event.toolName,
        step: event.step,
      }));
      appendLog(
        "tool  ",
        `${event.toolName} started (step ${event.step})`,
        COLORS.muted,
      );
      return;
    }

    if (event.type === "tool_finished") {
      updateActivity(formatActivitySnapshot({
        phase: event.result.ok ? "tool_finished" : "tool_failed",
        message: event.toolName,
        step: event.step,
      }));
      appendLog(
        "tool  ",
        `${event.toolName} ${event.result.ok ? "completed" : "failed"}`,
        event.result.ok ? COLORS.muted : COLORS.error,
      );
      return;
    }

    if (event.type === "run_completed" && liveAssistantEntry !== null) {
      liveAssistantEntry.content = `assistant  ${event.result.answer}`;
    }
  };

  const resolvePendingShellApproval = (
    decision: ShellApprovalDecision,
  ): void => {
    const pending = pendingShellApproval;

    if (pending === null) {
      return;
    }

    pendingShellApproval = null;
    pending.cleanup();
    approvalPanel.visible = false;
    approvalText.content = "";
    taskInput.value = "";
    taskInput.placeholder = "itemD is working…";
    footer.content = DEFAULT_FOOTER_TEXT;
    footer.fg = COLORS.muted;
    pending.resolve(decision);
  };

  const formatShellApprovalCommand = (
    request: ShellApprovalRequest,
  ): string =>
    [request.call.executable, ...request.call.args]
      .map((part) => JSON.stringify(part))
      .join(" ");

  const shellApproval = new ShellApprovalController(async (request, signal) => {
    const command = formatShellApprovalCommand(request);
    appendLog(
      "approval  ",
      `The model requested: ${command}\n` +
        "Enter 1 for once, 2 to allow this exact command later, or 3 to deny.",
      COLORS.warning,
    );
    approvalText.content = formatShellApprovalPanel(command);
    approvalPanel.visible = true;
    updateActivity("waiting_for_approval  •  shell command", true);
    footer.content = " Approval: 1 once • 2 allow later • 3 deny • Esc deny ";
    footer.fg = COLORS.warning;
    taskInput.placeholder = "Enter 1, 2, or 3";

    return new Promise<ShellApprovalDecision>((resolve) => {
      const onAbort = (): void => {
        resolvePendingShellApproval("deny");
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };

      pendingShellApproval = { resolve, cleanup };
      signal?.addEventListener("abort", onAbort, { once: true });

      if (signal?.aborted) {
        onAbort();
      }
    });
  });

  const applyTheme = (theme: UiTheme): void => {
    COLORS = theme;
    renderer.setBackgroundColor(theme.background);
    app.backgroundColor = theme.background;
    header.backgroundColor = theme.background;
    logoFallback.color = theme.accent;
    statusText.fg = busy ? theme.warning : theme.success;
    activityBox.backgroundColor = theme.panel;
    activityText.fg = theme.muted;
    approvalPanel.backgroundColor = theme.panel;
    approvalText.fg = theme.warning;
    transcript.viewport.backgroundColor = theme.background;
    transcript.verticalScrollBar.trackOptions = {
      foregroundColor: theme.accent,
      backgroundColor: theme.panel,
    };
    commandPalette.backgroundColor = theme.panel;
    commandPaletteText.fg = theme.text;
    commandPaletteText.selectionBg = theme.selectionBackground;
    commandPaletteText.selectionFg = theme.selectionText;
    inputBox.backgroundColor = theme.panel;
    taskInput.backgroundColor = theme.panel;
    taskInput.focusedBackgroundColor = theme.panel;
    taskInput.textColor = theme.text;
    taskInput.focusedTextColor = theme.text;
    taskInput.placeholderColor = theme.muted;
    taskInput.cursorColor = theme.accent;
    taskInput.selectionBg = theme.selectionBackground;
    taskInput.selectionFg = theme.selectionText;
    footer.bg = theme.panel;
    footer.fg = theme.muted;

    for (const entry of transcriptEntries) {
      entry.renderable.fg = theme[entry.colorRole];
      entry.renderable.selectionBg = theme.selectionBackground;
      entry.renderable.selectionFg = theme.selectionText;
    }

  };

  const resetTranscript = (message: string): void => {
    resetLiveAssistant();

    for (const child of transcript.getChildren()) {
      child.destroyRecursively();
    }

    transcriptEntries.length = 0;

    appendLog("", message, COLORS.muted);
  };

  const clearTranscript = (): void => {
    resetTranscript(
      "itemD is ready. Type / for commands, ! for shell, or enter a coding task.",
    );
  };

  const renderSessionHistory = (): void => {
    if (sessionContext.messages.length === 0) {
      return;
    }

    appendLog("history  ", "Restored session history", COLORS.muted);
    for (const message of sessionContext.messages) {
      const presented = presentSessionMessage(message);
      const color = presented.label === "you"
        ? COLORS.user
        : presented.label === "tool"
          ? COLORS.muted
          : COLORS.text;
      appendLog(`${presented.label}  `, presented.text, color);
    }
  };

  const startNewSession = (): void => {
    sessionContext = sessionService.createSession(options.workspaceRoot);
    resetLiveAssistant();
    resetTranscript("New session started. Active configuration retained.");
  };

  const updateCommandPalette = (value: string): void => {
    if (replayPickerVisible || sessionPickerVisible || configurationMenu !== null) {
      return;
    }

    visibleCommands = suggestTuiCommands(value);
    selectedCommandIndex = Math.min(
      selectedCommandIndex,
      Math.max(visibleCommands.length - 1, 0),
    );
    commandPalette.visible = visibleCommands.length > 0;

    if (visibleCommands.length === 0) {
      return;
    }

    commandPalette.height = visibleCommands.length + 2;
    commandPaletteText.content = visibleCommands
      .map((command, index) => {
        const marker = index === selectedCommandIndex ? "›" : " ";
        return `${marker} ${command.usage.padEnd(22)} ${command.description}`;
      })
      .join("\n");
  };

  const updateReplayPicker = (): void => {
    const total = replayChoices.length;
    const visibleChoices = replayChoices.slice(0, MAX_REPLAY_CHOICES);
    commandPalette.title = " replays ";
    commandPaletteText.content = visibleChoices
      .map((trace, index) => {
        const marker = index === selectedReplayIndex ? "›" : " ";
        return `${marker} ${trace.traceId}  ${trace.modifiedAt}`;
      })
      .join("\n");
    commandPalette.height = visibleChoices.length + 2;
    commandPalette.visible = true;
    footer.content = total > MAX_REPLAY_CHOICES
      ? ` ↑/↓ select • Enter open • Esc close • showing newest ${MAX_REPLAY_CHOICES} of ${total} `
      : " ↑/↓ select • Enter open • Esc close ";
    footer.fg = COLORS.muted;
  };

  const closeReplayPicker = (): void => {
    replayPickerVisible = false;
    replayChoices = [];
    selectedReplayIndex = 0;
    commandPalette.title = " commands ";
    commandPalette.visible = false;
    commandPaletteText.content = "";

    if (toastTimer === null && !busy) {
      footer.content = DEFAULT_FOOTER_TEXT;
      footer.fg = COLORS.muted;
    }
  };

  const updateSessionPicker = (): void => {
    const total = sessionChoices.length;
    const visibleChoices = sessionChoices.slice(0, 10);
    commandPalette.title = " sessions ";
    commandPaletteText.content = visibleChoices
      .map((session, index) => {
        const marker = index === selectedSessionIndex ? "›" : " ";
        const activeMarker = session.id === sessionContext.session.id ? "*" : " ";
        return `${marker} ${activeMarker} ${session.id}  ${basename(session.workspaceRoot)}  ${session.updatedAt}`;
      })
      .join("\n");
    commandPalette.height = visibleChoices.length + 2;
    commandPalette.visible = true;
    footer.content = total > 10
      ? " ↑/↓ select • Enter resume • Esc close • showing newest 10 "
      : " ↑/↓ select • Enter resume • Esc close ";
    footer.fg = COLORS.muted;
  };

  const closeSessionPicker = (): void => {
    sessionPickerVisible = false;
    sessionChoices = [];
    selectedSessionIndex = 0;
    commandPalette.title = " commands ";
    commandPalette.visible = false;
    commandPaletteText.content = "";

    if (toastTimer === null && !busy) {
      footer.content = DEFAULT_FOOTER_TEXT;
      footer.fg = COLORS.muted;
    }
  };

  const openSessionPicker = (): void => {
    sessionChoices = sessionService
      .listSessions(10)
      .filter((session) => session.workspaceRoot === options.workspaceRoot);

    if (sessionChoices.length === 0) {
      appendLog("sessions  ", "No sessions found for this workspace.", COLORS.muted);
      return;
    }

    selectedSessionIndex = Math.max(
      0,
      sessionChoices.findIndex((session) => session.id === sessionContext.session.id),
    );
    sessionPickerVisible = true;
    updateSessionPicker();
  };

  const resumeSessionById = (sessionId: string): void => {
    const resumed = sessionService.resumeSession(sessionId, options.workspaceRoot);

    if (!resumed.ok) {
      appendLog("session error  ", resumed.error.message, COLORS.error);
      return;
    }

    closeSessionPicker();
    sessionContext = resumed.context;
    resetTranscript("Session resumed. Restored message history below.");
    renderSessionHistory();
  };

  const selectSession = (): void => {
    const selected = sessionChoices[selectedSessionIndex];

    if (selected === undefined) {
      closeSessionPicker();
      return;
    }

    resumeSessionById(selected.id);
  };

  const closeConfigurationMenu = (): void => {
    configurationMenu = null;
    configurationChoices = [];
    selectedConfigurationIndex = 0;
    commandPalette.title = " commands ";
    commandPalette.visible = false;
    commandPaletteText.content = "";

    if (toastTimer === null && !busy) {
      footer.content = DEFAULT_FOOTER_TEXT;
      footer.fg = COLORS.muted;
    }
  };

  const updateConfigurationMenu = (): void => {
    if (configurationMenu === null) {
      return;
    }

    const provider = PROVIDER_CATALOG.find(
      (candidate) => candidate.id === active.configuration.provider && candidate.enabled,
    ) ?? PROVIDER_CATALOG[0];

    if (!provider.enabled) {
      return;
    }

    if (configurationMenu.level === "root") {
      configurationChoices = [
        {
          label: "Model",
          detail: `Current: ${active.configuration.model}`,
        },
        {
          label: "Reasoning effort",
          detail: `Current: ${active.configuration.effort}`,
        },
        {
          label: "Open browser setup",
          detail: "API keys, Serper key, and all model settings",
        },
        { label: "Cancel", detail: "Return to the task input" },
      ];
    } else if (configurationMenu.level === "model") {
      configurationChoices = [
        ...provider.models.map((model) => ({
          label: model.displayName,
          detail: model.id === active.configuration.model ? "Current" : model.id,
        })),
        { label: "Back", detail: "Return to configuration" },
      ];
    } else {
      configurationChoices = [
        ...provider.reasoningEfforts.map((effort) => ({
          label: effort.displayName,
          detail: effort.id === active.configuration.effort ? "Current" : effort.id,
        })),
        { label: "Back", detail: "Return to configuration" },
      ];
    }

    selectedConfigurationIndex = Math.min(
      selectedConfigurationIndex,
      Math.max(configurationChoices.length - 1, 0),
    );
    commandPalette.title = configurationMenu.level === "root"
      ? " configuration "
      : configurationMenu.level === "model"
        ? " model "
        : " reasoning effort ";
    commandPaletteText.content = configurationChoices
      .map((choice, index) => {
        const marker = index === selectedConfigurationIndex ? "›" : " ";
        return `${marker} ${choice.label.padEnd(24)} ${choice.detail}`;
      })
      .join("\n");
    commandPalette.height = configurationChoices.length + 2;
    commandPalette.visible = true;
    footer.content = " ↑/↓ select • Enter choose • Esc close ";
    footer.fg = COLORS.muted;
  };

  const openConfigurationMenu = (
    level: ConfigurationMenu["level"] = "root",
  ): void => {
    configurationMenu = { level };
    selectedConfigurationIndex = 0;
    updateConfigurationMenu();
  };

  const setBusy = (
    value: boolean,
    status = "READY",
    showLoader = false,
  ): void => {
    busy = value;
    stopLoader();
    stopElapsedTimer();

    if (renderer.isDestroyed) {
      return;
    }

    statusText.content = status;
    statusText.fg = value ? COLORS.warning : COLORS.success;

    if (value && showLoader) {
      startLoader();
    }

    if (!value) {
      updateActivity("", false);
      approvalPanel.visible = false;
    }

    if (value && (showLoader || status === "REPLAY" || status === "SHELL")) {
      startElapsedTimer(
        status === "REPLAY" ? "REPLAY" : status === "SHELL" ? "SHELL" : "ELAPSED",
      );
    }

    if (value) {
      taskInput.blur();
      taskInput.placeholder = "itemD is working…";
    } else if (!renderer.isDestroyed) {
      taskInput.placeholder = "Describe a task or type / for commands";
      taskInput.focus();
      if (toastTimer === null) {
        footer.content = DEFAULT_FOOTER_TEXT;
        footer.fg = COLORS.muted;
      }
    }
  };

  const runReplay = async (traceId: string): Promise<void> => {
    if (activeReplayController !== null) {
      return;
    }

    const controller = new AbortController();
    activeReplayController = controller;
    setBusy(true, "REPLAY");

    try {
      const result = await replayTrace(options.workspaceRoot, traceId);

      if (!result.ok) {
        appendLog("replay error  ", result.error.message, COLORS.error);
        return;
      }

      appendLog(
        "replay\n",
        `trace: ${result.traceId}\n${result.events.length} events\n${streamReasoning ? "reasoning: visible" : "reasoning: hidden"}`,
        COLORS.muted,
      );

      for (const event of result.events) {
        if (controller.signal.aborted) {
          appendLog("replay  ", "Replay stopped.", COLORS.warning);
          return;
        }

        appendLog(
          "event  ",
          formatReplayEvent(event, streamReasoning),
          COLORS.text,
        );
        await renderer.idle();
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) {
              return;
            }

            settled = true;
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          };
          const timeout = setTimeout(finish, REPLAY_EVENT_DELAY_MS);
          const onAbort = (): void => {
            clearTimeout(timeout);
            finish();
          };

          if (controller.signal.aborted) {
            onAbort();
          } else {
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
          }
        });
      }
    } finally {
      if (activeReplayController === controller) {
        activeReplayController = null;
      }

      setBusy(false);
    }
  };

  const selectReplay = (): void => {
    const trace = replayChoices[selectedReplayIndex];

    if (trace === undefined) {
      closeReplayPicker();
      return;
    }

    closeReplayPicker();
    void runReplay(trace.traceId);
  };

  const openReplayPicker = (
    traces: Array<{ traceId: string; modifiedAt: string }>,
  ): void => {
    replayChoices = traces.slice(0, MAX_REPLAY_CHOICES);
    selectedReplayIndex = 0;
    replayPickerVisible = true;
    updateReplayPicker();
  };

  let clipboardDisposePromise: Promise<void> | null = null;

  const disposeClipboard = (): Promise<void> => {
    if (clipboard === null) {
      return Promise.resolve();
    }

    clipboardDisposePromise ??= clipboard.dispose();
    return clipboardDisposePromise;
  };

  const copySelection = async (selection: Selection): Promise<void> => {
    const text = getTranscriptSelectionText(selection, transcript);

    if (text === null || renderer.isDestroyed) {
      return;
    }

    let copied = false;

    try {
      if (clipboard !== null) {
        const result = await clipboard.writeText(text, {
          destination: "best-available",
        });
        copied =
          result.host.status === "written" ||
          result.terminal.status === "attempted";
      } else {
        copied = renderer.copyToClipboardOSC52(text);
      }
    } catch {
      copied = false;
    }

    showToast(
      copied ? copiedCharactersMessage(text) : "Copy failed",
      copied ? COLORS.success : COLORS.error,
    );

    if (!busy && !renderer.isDestroyed) {
      taskInput.focus();
    }
  };

  const reloadConfiguration = async (): Promise<void> => {
    const replacement = await loadActiveConfiguration(options.config);

    if (!replacement.ok) {
      appendLog(
        "configuration error  ",
        `${replacement.message} Keeping the previous configuration.`,
        COLORS.error,
      );
      return;
    }

    active = replacement.active;
    appendLog(
      "configuration  ",
      "Reloaded API key and model settings.",
      COLORS.success,
    );
  };

  const applyConfigurationSelection = async (
    selection: Partial<Pick<ItemDConfiguration, "model" | "effort">>,
  ): Promise<void> => {
    const candidate: ItemDConfiguration = {
      ...active.configuration,
      ...selection,
    };
    const storedResult = await readConfiguration(options.config);

    if (!storedResult.ok) {
      appendLog("configuration error  ", storedResult.error.message, COLORS.error);
      return;
    }

    if (storedResult.configuration === null) {
      const replacement = createActiveConfiguration(candidate);

      if (!replacement.ok) {
        appendLog("configuration error  ", replacement.message, COLORS.error);
        return;
      }

      active = replacement.active;
      appendLog(
        "configuration  ",
        "Updated for this session. Add a saved configuration through /setup browser.",
        COLORS.success,
      );
      return;
    }

    const writeResult = await writeConfiguration(
      {
        ...storedResult.configuration,
        ...selection,
      },
      options.config,
    );

    if (!writeResult.ok) {
      appendLog("configuration error  ", writeResult.error.message, COLORS.error);
      return;
    }

    const replacement = await loadActiveConfiguration(options.config);

    if (!replacement.ok) {
      appendLog("configuration error  ", replacement.message, COLORS.error);
      return;
    }

    active = replacement.active;
    appendLog("configuration  ", "Saved and applied.", COLORS.success);
  };

  const openBrowserConfiguration = async (): Promise<void> => {
    closeConfigurationMenu();
    setBusy(true, "SETUP");
    const controller = new AbortController();
    activeSetupController = controller;

    try {
      const result = await runBrowserSetup({
        config: options.config,
        initialConfiguration: active.configuration,
        signal: controller.signal,
      });

      if (result.status === "saved") {
        await reloadConfiguration();
      } else if (result.status === "cancelled") {
        appendLog("configuration  ", "Setup cancelled. Keeping the previous configuration.", COLORS.warning);
      } else {
        appendLog("configuration error  ", result.message, COLORS.error);
      }
    } finally {
      if (activeSetupController === controller) {
        activeSetupController = null;
      }
      setBusy(false);
    }
  };

  const selectConfigurationChoice = async (): Promise<void> => {
    const choice = configurationChoices[selectedConfigurationIndex];

    if (configurationMenu === null || choice === undefined) {
      return;
    }

    if (configurationMenu.level === "root") {
      if (choice.label === "Model") {
        configurationMenu = { level: "model" };
        selectedConfigurationIndex = 0;
        updateConfigurationMenu();
      } else if (choice.label === "Reasoning effort") {
        configurationMenu = { level: "effort" };
        selectedConfigurationIndex = 0;
        updateConfigurationMenu();
      } else if (choice.label === "Open browser setup") {
        await openBrowserConfiguration();
      } else {
        closeConfigurationMenu();
      }
      return;
    }

    if (choice.label === "Back") {
      configurationMenu = { level: "root" };
      selectedConfigurationIndex = 0;
      updateConfigurationMenu();
      return;
    }

    const provider = PROVIDER_CATALOG.find(
      (candidate) => candidate.id === active.configuration.provider && candidate.enabled,
    ) ?? PROVIDER_CATALOG[0];

    if (!provider.enabled) {
      closeConfigurationMenu();
      return;
    }

    const selected = configurationMenu.level === "model"
      ? provider.models.find((candidate) => candidate.displayName === choice.label)
      : provider.reasoningEfforts.find((candidate) => candidate.displayName === choice.label);

    if (selected === undefined) {
      return;
    }

    const selectionLevel = configurationMenu.level;
    closeConfigurationMenu();
    setBusy(true, "CONFIG");

    try {
      await applyConfigurationSelection(
        selectionLevel === "model"
          ? { model: selected.id }
          : { effort: selected.id as ItemDConfiguration["effort"] },
      );
    } finally {
      setBusy(false);
    }
  };

  const destroyed = new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, resolve);
  });
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      activeRunController?.abort();
      activeReplayController?.abort();
      activeSetupController?.abort();
      resolvePendingShellApproval("deny");
      stopLoader();
      stopElapsedTimer();

      if (toastTimer !== null) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }

      try {
        await disposeClipboard();
      } catch {
        // Terminal restoration must not depend on clipboard cleanup.
      } finally {
        sessionService.close();
        if (!renderer.isDestroyed) {
          renderer.destroy();
        }
      }
    })();

    return shutdownPromise;
  };

  const onShutdownSignal = (): void => {
    void shutdown();
  };

  process.once("SIGTERM", onShutdownSignal);
  process.once("SIGHUP", onShutdownSignal);

  const handleCommand = async (line: string): Promise<void> => {
    const words = line.split(/\s+/);
    const command = words[0];

    switch (command) {
      case "/help":
        appendLog(
          "commands\n",
          `${formatTuiCommandHelp()}\n\n${KEYBOARD_HELP}`,
          COLORS.text,
        );
        return;
      case "/config":
        appendLog("configuration\n", configurationText(active), COLORS.text);
        return;
      case "/reasoning": {
        const requested = words[1]?.toLowerCase();

        if (
          requested !== undefined &&
          requested !== "on" &&
          requested !== "off"
        ) {
          appendLog(
            "usage  ",
            "/reasoning [on|off] (toggle recorded reasoning in replays)",
            COLORS.warning,
          );
          return;
        }

        streamReasoning = requested === undefined
          ? !streamReasoning
          : requested === "on";
        appendLog(
          "reasoning  ",
          `Replay reasoning ${streamReasoning ? "enabled" : "disabled"}.`,
          COLORS.success,
        );
        return;
      }
      case "/reload":
        await reloadConfiguration();
        return;
      case "/setup":
      case "/adapter":
        if (words[1] === "browser") {
          await openBrowserConfiguration();
        } else if (words.length > 1) {
          appendLog("usage  ", "/setup [browser]", COLORS.warning);
        } else {
          openConfigurationMenu();
        }
        return;
      case "/model": {
        const provider = PROVIDER_CATALOG.find(
          (candidate) => candidate.id === active.configuration.provider && candidate.enabled,
        ) ?? PROVIDER_CATALOG[0];
        const requested = words[1];

        if (!provider.enabled) {
          appendLog("configuration error  ", "The active provider is disabled.", COLORS.error);
          return;
        }

        if (requested === undefined) {
          openConfigurationMenu("model");
          return;
        }

        const model = provider.models.find((candidate) => candidate.id === requested);

        if (model === undefined || words.length > 2) {
          appendLog(
            "usage  ",
            `/model <${provider.models.map((candidate) => candidate.id).join("|")}>`,
            COLORS.warning,
          );
          return;
        }

        await applyConfigurationSelection({ model: model.id });
        return;
      }
      case "/effort": {
        const provider = PROVIDER_CATALOG.find(
          (candidate) => candidate.id === active.configuration.provider && candidate.enabled,
        ) ?? PROVIDER_CATALOG[0];
        const requested = words[1];

        if (!provider.enabled) {
          appendLog("configuration error  ", "The active provider is disabled.", COLORS.error);
          return;
        }

        if (requested === undefined) {
          openConfigurationMenu("effort");
          return;
        }

        const effort = provider.reasoningEfforts.find((candidate) => candidate.id === requested);

        if (effort === undefined || words.length > 2) {
          appendLog(
            "usage  ",
            `/effort <${provider.reasoningEfforts.map((candidate) => candidate.id).join("|")}>`,
            COLORS.warning,
          );
          return;
        }

        await applyConfigurationSelection({ effort: effort.id });
        return;
      }
      case "/replays": {
        const result = await listTraces(options.workspaceRoot);

        if (!result.ok) {
          appendLog("replay error  ", result.error.message, COLORS.error);
          return;
        }

        if (result.traces.length === 0) {
          appendLog("replays  ", "No recorded runs.", COLORS.muted);
          return;
        }

        openReplayPicker(result.traces);
        return;
      }
      case "/replay": {
        if (words.length !== 2 || words[1] === undefined) {
          appendLog("usage  ", "/replay <trace-id>", COLORS.warning);
          return;
        }

        await runReplay(words[1]);
        return;
      }
      case "/sessions":
        if (words.length !== 1) {
          appendLog("usage  ", "/sessions", COLORS.warning);
          return;
        }

        openSessionPicker();
        return;
      case "/resume":
        if (words.length === 1) {
          openSessionPicker();
          return;
        }

        if (words.length !== 2 || words[1] === undefined) {
          appendLog("usage  ", "/resume [session-id]", COLORS.warning);
          return;
        }

        resumeSessionById(words[1]);
        return;
      case "/clear":
        clearTranscript();
        return;
      case "/new":
        startNewSession();
        return;
      case "/theme": {
        const requestedTheme = words[1]?.toLowerCase();
        let nextTheme: UiTheme;

        if (requestedTheme === undefined) {
          nextTheme = COLORS.name === "dark" ? LIGHT_THEME : DARK_THEME;
        } else if (requestedTheme === "dark") {
          nextTheme = DARK_THEME;
        } else if (requestedTheme === "light") {
          nextTheme = LIGHT_THEME;
        } else {
          appendLog(
            "usage  ",
            "/theme [dark|light] (omit the argument to toggle)",
            COLORS.warning,
          );
          return;
        }

        applyTheme(nextTheme);
        appendLog(
          "theme  ",
          `Switched to ${nextTheme.name} mode.`,
          COLORS.success,
        );
        return;
      }
      case "/exit":
      case "/quit":
        await shutdown();
        return;
      default:
        appendLog(
          "unknown command  ",
          `${command ?? line}. Type /help to see available commands.`,
          COLORS.warning,
        );
    }
  };

  const handleLine = async (line: string): Promise<void> => {
    if (busy || renderer.isDestroyed) {
      return;
    }

    const isDirectShell = line.startsWith("!");
    const isAgentTask = !line.startsWith("/") && !isDirectShell;
    const runController = isAgentTask || isDirectShell
      ? new AbortController()
      : null;
    activeRunController = runController;
    setBusy(
      true,
      isAgentTask ? "RUNNING" : isDirectShell ? "SHELL" : "COMMAND",
      isAgentTask,
    );

    try {
      if (line.startsWith("/")) {
        await handleCommand(line);
        return;
      }

      if (isDirectShell) {
        const shellInput = line.slice(1).trim();
        const shellResult = await executePrefixedShellCommand(
          shellInput,
          options.workspaceRoot,
          runController?.signal,
        );
        appendLog(
          "shell\n",
          formatShellResult(shellInput, shellResult),
          shellResult.ok ? COLORS.text : COLORS.error,
        );
        return;
      }

      appendLog("you  ", line, COLORS.user);
      appendLog(
        "itemD  ",
        `Running with ${active.configuration.model}…`,
        COLORS.muted,
      );
      resetLiveAssistant();
      sessionContext = sessionService.appendMessage(
        sessionContext.session.id,
        { role: "user", content: line },
      );
      const runOptions = {
        ...(runController === null
          ? {}
          : { signal: runController.signal }),
        tools: {
          shellMode: options.shellMode ?? "ask",
          shellApproval,
          ...(active.webSearchProvider === undefined
            ? {}
            : { webSearchProvider: active.webSearchProvider }),
        },
        initialMessages: sessionContext.messages,
        onMessage: (message: ModelMessage): void => {
          sessionContext = sessionService.appendMessage(
            sessionContext.session.id,
            message,
          );
        },
        onEvent: (event: AgentRunEvent): void => {
          if (streamReasoning && event.type === "reasoning") {
            appendLog(
              `reasoning step ${event.step}\n`,
              event.text,
              COLORS.muted,
            );
          }
        },
        onRuntimeEvent: handleRuntimeEvent,
      };
      const result = await runAgent(
        line,
        active.adapter,
        options.workspaceRoot,
        runOptions,
      );

      if (activeRunController === runController) {
        activeRunController = null;
      }

      if (result.ok) {
        appendLog(
          "done  ",
          liveAssistantText.length === 0 ? result.answer : "Response complete.",
          COLORS.success,
        );
      } else if (result.status === "cancelled") {
        appendLog("stopped  ", result.error.message, COLORS.warning);
      } else {
        appendLog(
          `${result.status}  `,
          result.error.message,
          COLORS.error,
        );
      }

      appendLog(
        "run  ",
        `${result.steps} step${result.steps === 1 ? "" : "s"}  •  trace ${result.traceId}`,
        COLORS.muted,
      );
    } catch (error: unknown) {
      appendLog("itemD error  ", getErrorMessage(error), COLORS.error);
    } finally {
      if (activeRunController === runController) {
        activeRunController = null;
      }

      setBusy(false);
    }
  };

  const selectCommand = (indexDelta: number): void => {
    if (visibleCommands.length === 0) {
      return;
    }

    selectedCommandIndex =
      (selectedCommandIndex + indexDelta + visibleCommands.length) %
      visibleCommands.length;
    updateCommandPalette(taskInput.value);
  };

  const completeSelectedCommand = (): TuiCommand | undefined => {
    const selected = visibleCommands[selectedCommandIndex];

    if (selected === undefined) {
      return undefined;
    }

    taskInput.value = `${selected.name}${selected.name === "/replay" ? " " : ""}`;
    updateCommandPalette(taskInput.value);
    return selected;
  };

  const onKeyPress = (key: KeyEvent): void => {
    if (key.ctrl && key.name === "c") {
      key.stopPropagation();
      void shutdown();
      return;
    }

    if (key.name === "escape" && pendingShellApproval !== null) {
      key.stopPropagation();
      resolvePendingShellApproval("deny");
      showToast("Shell command denied", COLORS.warning);
      return;
    }

    if (
      key.name === "escape" &&
      activeRunController !== null &&
      !activeRunController.signal.aborted
    ) {
      key.stopPropagation();
      stopLoader();
      stopElapsedTimer();
      activeRunController.abort();
      statusText.content = "STOPPING";
      statusText.fg = COLORS.warning;
      showToast("Stopping task…", COLORS.warning);
      return;
    }

    if (
      key.name === "escape" &&
      activeReplayController !== null &&
      !activeReplayController.signal.aborted
    ) {
      key.stopPropagation();
      stopElapsedTimer();
      activeReplayController.abort();
      statusText.content = "STOPPING";
      statusText.fg = COLORS.warning;
      showToast("Stopping replay…", COLORS.warning);
      return;
    }

    if (configurationMenu !== null) {
      if (key.name === "escape") {
        key.preventDefault();
        if (configurationMenu.level === "root") {
          closeConfigurationMenu();
        } else {
          configurationMenu = { level: "root" };
          selectedConfigurationIndex = 0;
          updateConfigurationMenu();
        }
        return;
      }

      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        const delta = key.name === "up" ? -1 : 1;
        selectedConfigurationIndex =
          (selectedConfigurationIndex + delta + configurationChoices.length) %
          configurationChoices.length;
        updateConfigurationMenu();
        return;
      }

      if (key.name === "return") {
        key.preventDefault();
        key.stopPropagation();
        void selectConfigurationChoice();
        return;
      }
    }

    if (replayPickerVisible) {
      if (key.name === "escape") {
        key.preventDefault();
        closeReplayPicker();
        return;
      }

      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        const delta = key.name === "up" ? -1 : 1;
        selectedReplayIndex =
          (selectedReplayIndex + delta + replayChoices.length) %
          replayChoices.length;
        updateReplayPicker();
        return;
      }

      if (key.name === "return") {
        key.preventDefault();
        key.stopPropagation();
        selectReplay();
        return;
      }
    }

    if (sessionPickerVisible) {
      if (key.name === "escape") {
        key.preventDefault();
        closeSessionPicker();
        return;
      }

      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        const delta = key.name === "up" ? -1 : 1;
        selectedSessionIndex =
          (selectedSessionIndex + delta + sessionChoices.length) %
          sessionChoices.length;
        updateSessionPicker();
        return;
      }

      if (key.name === "return") {
        key.preventDefault();
        key.stopPropagation();
        selectSession();
        return;
      }
    }

    if (key.name === "pageup") {
      key.preventDefault();
      transcript.scrollBy(-1, "viewport");
      return;
    }

    if (key.name === "pagedown") {
      key.preventDefault();
      transcript.scrollBy(1, "viewport");
      return;
    }

    if (key.ctrl && key.name === "up") {
      key.preventDefault();
      transcript.scrollBy(-3);
      return;
    }

    if (key.ctrl && key.name === "down") {
      key.preventDefault();
      transcript.scrollBy(3);
      return;
    }

    if (!commandPalette.visible) {
      return;
    }

    if (key.name === "up") {
      key.preventDefault();
      selectCommand(-1);
      return;
    }

    if (key.name === "down") {
      key.preventDefault();
      selectCommand(1);
      return;
    }

    if (key.name === "tab") {
      key.preventDefault();
      completeSelectedCommand();
      return;
    }

    if (key.name === "return") {
      const selected = visibleCommands[selectedCommandIndex];

      if (
        selected !== undefined &&
        !taskInput.value.includes(" ") &&
        (taskInput.value !== selected.name || selected.name === "/replay")
      ) {
        key.preventDefault();
        completeSelectedCommand();
      }
    }
  };

  const onSelection = (selection: Selection): void => {
    void copySelection(selection);
  };

  renderer.keyInput.on("keypress", onKeyPress);
  renderer.on(CliRenderEvents.SELECTION, onSelection);
  renderer.once(CliRenderEvents.DESTROY, () => {
    renderer.keyInput.off("keypress", onKeyPress);
    renderer.off(CliRenderEvents.SELECTION, onSelection);
    process.removeListener("SIGTERM", onShutdownSignal);
    process.removeListener("SIGHUP", onShutdownSignal);
    stopLoader();
    stopElapsedTimer();

    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  });
  taskInput.on(InputRenderableEvents.INPUT, (value: string) => {
    selectedCommandIndex = 0;
    updateCommandPalette(value);
  });
  taskInput.on(InputRenderableEvents.ENTER, (value: string) => {
    const line = value.trim();

    if (pendingShellApproval !== null) {
      const decision = parseShellApprovalDecision(line);

      if (decision === null) {
        showToast("Choose 1, 2, or 3", COLORS.warning);
        return;
      }

      resolvePendingShellApproval(decision);
      return;
    }

    if (line.length === 0 || busy) {
      return;
    }

    taskInput.value = "";
    updateCommandPalette("");
    void handleLine(line);
  });

  clearTranscript();
  renderSessionHistory();
  taskInput.focus();

  await destroyed;

  try {
    await disposeClipboard();
  } catch {
    // Renderer cleanup remains authoritative when clipboard disposal fails.
  }

  try {
    await renderer.closed;
  } catch {
    // The renderer already made its best effort to restore the terminal.
  }

  sessionService.close();
}
