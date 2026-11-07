import { basename } from "node:path";
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
import { runAgent } from "../agent/runner.ts";
import {
  resolveConfiguration,
  type ConfigurationOptions,
  type ItemDConfiguration,
} from "../config/configuration.ts";
import type { ModelAdapter } from "../model/adapter.ts";
import { createModelAdapter } from "../model/factory.ts";
import { getErrorMessage } from "../shared/runtime.ts";
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
  runSetup,
  TerminalTuiIO,
} from "./setup.ts";

type ThemeName = "dark" | "light";

type UiTheme = {
  name: ThemeName;
  background: string;
  panel: string;
  border: string;
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
  border: "#30363d",
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
  border: "#afb8c1",
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
  "PgUp/PgDn      Scroll the transcript\n" +
  "Ctrl+Up/Down   Fine-scroll the transcript\n" +
  "Mouse drag     Select and copy transcript text\n" +
  "Ctrl+C         Exit itemD";

const LOGO_ASSET_NAME = "Just_One_More_Commit.png";

function logoSource(): URL {
  const bun = (
    globalThis as {
      Bun?: { isStandaloneExecutable?: boolean };
    }
  ).Bun;
  const assetPath = bun?.isStandaloneExecutable === true
    ? `assets/${LOGO_ASSET_NAME}`
    : `../../assets/${LOGO_ASSET_NAME}`;

  return new URL(assetPath, import.meta.url);
}

type OpenTuiOptions = {
  workspaceRoot: string;
  config: ConfigurationOptions;
};

type ActiveConfiguration = {
  configuration: ItemDConfiguration;
  adapter: ModelAdapter;
};

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

  const adapterResult = createModelAdapter(result.configuration);

  if (!adapterResult.ok) {
    return { ok: false, message: adapterResult.error.message };
  }

  return {
    ok: true,
    active: {
      configuration: result.configuration,
      adapter: adapterResult.adapter,
    },
  };
}

async function runInitialSetup(
  config: ConfigurationOptions,
): Promise<ActiveConfiguration | null> {
  const existing = await loadActiveConfiguration(config);

  if (existing.ok) {
    return existing.active;
  }

  const io = new TerminalTuiIO();
  io.write(`[configuration] ${existing.message}\n`);

  try {
    const result = await runSetup(io, config);

    if (result.status !== "saved") {
      io.write("Goodbye.\n");
      return null;
    }
  } finally {
    io.close();
  }

  const configured = await loadActiveConfiguration(config);

  if (!configured.ok) {
    process.stderr.write(`[configuration error] ${configured.message}\n`);
    return null;
  }

  return configured.active;
}

function configurationText(active: ActiveConfiguration): string {
  const { provider, model, effort } = active.configuration;
  return `provider: ${provider}\nmodel: ${model}\neffort: ${effort}`;
}

export async function runOpenTui(options: OpenTuiOptions): Promise<void> {
  COLORS = DARK_THEME;
  const initialActive = await runInitialSetup(options.config);

  if (initialActive === null) {
    return;
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
    height: 5,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingX: 1,
    columnGap: 2,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
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
  const headerText = new TextRenderable(renderer, {
    id: "active-configuration",
    content: "",
    fg: COLORS.text,
    flexGrow: 1,
    minWidth: 0,
    height: 2,
    wrapMode: "none",
  });
  const statusText = new TextRenderable(renderer, {
    id: "status",
    content: "READY",
    fg: COLORS.success,
    flexShrink: 0,
  });
  header.add(logo);
  header.add(logoFallback);
  header.add(headerText);
  header.add(statusText);

  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    width: "100%",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    title: " transcript ",
    titleColor: COLORS.muted,
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
  const commandPalette = new BoxRenderable(renderer, {
    id: "command-palette",
    width: "100%",
    height: 3,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.accent,
    title: " commands ",
    titleColor: COLORS.accent,
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
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    focusedBorderColor: COLORS.accent,
    title: " task ",
    titleColor: COLORS.accent,
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

  app.add(header);
  app.add(transcript);
  app.add(commandPalette);
  app.add(inputBox);
  app.add(footer);
  renderer.root.add(app);

  let selectedCommandIndex = 0;
  let visibleCommands: readonly TuiCommand[] = [];
  let busy = false;
  let activeRunController: AbortController | null = null;
  let stopLoaderTick: (() => void) | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const transcriptEntries: Array<{
    renderable: TextRenderable;
    colorRole: LogColorRole;
  }> = [];

  const stopLoader = (): void => {
    stopLoaderTick?.();
    stopLoaderTick = null;
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

  const updateHeader = (): void => {
    const configuration = active.configuration;
    headerText.content =
      `${configuration.provider}  •  ${configuration.model}  •  ${configuration.effort}\n` +
      `workspace: ${basename(options.workspaceRoot)}  •  theme: ${COLORS.name}`;
  };

  const appendLog = (
    label: string,
    message: string,
    color: string = COLORS.text,
  ): void => {
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
  };

  const applyTheme = (theme: UiTheme): void => {
    COLORS = theme;
    renderer.setBackgroundColor(theme.background);
    app.backgroundColor = theme.background;
    header.borderColor = theme.border;
    header.backgroundColor = theme.panel;
    logoFallback.color = theme.accent;
    headerText.fg = theme.text;
    statusText.fg = busy ? theme.warning : theme.success;
    transcript.borderColor = theme.border;
    transcript.titleColor = theme.muted;
    transcript.viewport.backgroundColor = theme.background;
    transcript.verticalScrollBar.trackOptions = {
      foregroundColor: theme.accent,
      backgroundColor: theme.panel,
    };
    commandPalette.borderColor = theme.accent;
    commandPalette.titleColor = theme.accent;
    commandPalette.backgroundColor = theme.panel;
    commandPaletteText.fg = theme.text;
    commandPaletteText.selectionBg = theme.selectionBackground;
    commandPaletteText.selectionFg = theme.selectionText;
    inputBox.borderColor = theme.border;
    inputBox.focusedBorderColor = theme.accent;
    inputBox.titleColor = theme.accent;
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

    updateHeader();
  };

  const resetTranscript = (message: string): void => {
    for (const child of transcript.getChildren()) {
      child.destroyRecursively();
    }

    transcriptEntries.length = 0;

    appendLog("", message, COLORS.muted);
  };

  const clearTranscript = (): void => {
    resetTranscript(
      "itemD is ready. Type / to inspect commands or enter a coding task.",
    );
  };

  const startNewSession = (): void => {
    resetTranscript("New session started. Active configuration retained.");
  };

  const updateCommandPalette = (value: string): void => {
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

  const setBusy = (
    value: boolean,
    status = "READY",
    showLoader = false,
  ): void => {
    busy = value;
    stopLoader();

    if (renderer.isDestroyed) {
      return;
    }

    statusText.content = status;
    statusText.fg = value ? COLORS.warning : COLORS.success;

    if (value && showLoader) {
      startLoader();
    }

    if (value) {
      taskInput.blur();
      taskInput.placeholder = "itemD is working…";
    } else if (!renderer.isDestroyed) {
      taskInput.placeholder = "Describe a task or type / for commands";
      taskInput.focus();
    }
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
    updateHeader();
    appendLog(
      "configuration  ",
      "Reloaded API key and model settings.",
      COLORS.success,
    );
  };

  const rerunSetup = async (): Promise<void> => {
    statusText.content = "SETUP";
    await renderer.idle();
    await renderer.suspend();
    const io = new TerminalTuiIO();
    let setupStatus: "saved" | "cancelled" | "failed" = "failed";

    try {
      const result = await runSetup(io, options.config);
      setupStatus = result.status;
    } finally {
      io.close();
      await renderer.resume();
    }

    if (setupStatus !== "saved") {
      appendLog(
        "configuration  ",
        "Setup cancelled. Keeping the previous configuration.",
        COLORS.warning,
      );
      return;
    }

    await reloadConfiguration();
  };

  const destroyed = new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, resolve);
  });
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      activeRunController?.abort();
      stopLoader();

      if (toastTimer !== null) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }

      try {
        await disposeClipboard();
      } catch {
        // Terminal restoration must not depend on clipboard cleanup.
      } finally {
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
      case "/reload":
        await reloadConfiguration();
        return;
      case "/setup":
      case "/adapter":
        await rerunSetup();
        return;
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

        appendLog(
          "replays\n",
          result.traces
            .map((trace) => `${trace.traceId}  ${trace.modifiedAt}`)
            .join("\n"),
          COLORS.text,
        );
        return;
      }
      case "/replay": {
        if (words.length !== 2 || words[1] === undefined) {
          appendLog("usage  ", "/replay <trace-id>", COLORS.warning);
          return;
        }

        const result = await replayTrace(options.workspaceRoot, words[1]);
        appendLog(
          "replay\n",
          JSON.stringify(result, null, 2),
          result.ok ? COLORS.text : COLORS.error,
        );
        return;
      }
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

    const isAgentTask = !line.startsWith("/");
    const runController = isAgentTask ? new AbortController() : null;
    activeRunController = runController;
    setBusy(
      true,
      isAgentTask ? "RUNNING" : "COMMAND",
      isAgentTask,
    );

    try {
      if (line.startsWith("/")) {
        await handleCommand(line);
        return;
      }

      appendLog("you  ", line, COLORS.user);
      appendLog(
        "itemD  ",
        `Running with ${active.configuration.model}…`,
        COLORS.muted,
      );
      const result = await runAgent(
        line,
        active.adapter,
        options.workspaceRoot,
        runController === null ? {} : { signal: runController.signal },
      );

      if (activeRunController === runController) {
        activeRunController = null;
      }

      if (result.ok) {
        appendLog("done  ", result.answer, COLORS.success);
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

    if (
      key.name === "escape" &&
      activeRunController !== null &&
      !activeRunController.signal.aborted
    ) {
      key.stopPropagation();
      stopLoader();
      activeRunController.abort();
      statusText.content = "STOPPING";
      statusText.fg = COLORS.warning;
      showToast("Stopping task…", COLORS.warning);
      return;
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

    if (line.length === 0 || busy) {
      return;
    }

    taskInput.value = "";
    updateCommandPalette("");
    void handleLine(line);
  });

  updateHeader();
  clearTranscript();
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
}
