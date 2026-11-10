import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ITEMD_CONFIG_VERSION,
  readConfiguration,
  writeConfiguration,
} from "../src/config/configuration.ts";
import {
  runSetup,
  runTui,
  type QuestionOptions,
  type TuiIO,
} from "../src/ui/tui.ts";
import { openSessionStore } from "../src/session/store.ts";

class FakeTuiIO implements TuiIO {
  interrupted = false;
  closed = false;
  readonly output: string[] = [];
  readonly questions: Array<{
    prompt: string;
    options: QuestionOptions;
  }> = [];
  private readonly responses: Array<string | null>;

  constructor(responses: Array<string | null>) {
    this.responses = responses;
  }

  async question(
    prompt: string,
    options: QuestionOptions = {},
  ): Promise<string | null> {
    this.questions.push({ prompt, options });
    const response = this.responses.shift();

    if (response === undefined) {
      throw new Error(`No fake response for prompt: ${prompt}`);
    }

    if (response === null) {
      this.interrupted = true;
    }

    return response;
  }

  write(text: string): void {
    this.output.push(text);
  }

  close(): void {
    this.closed = true;
  }

  text(): string {
    return this.output.join("");
  }
}

const temporaryDirectories: string[] = [];

async function createTemporaryPaths(): Promise<{
  workspace: string;
  configPath: string;
}> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "itemd-tui-test-"),
  );
  temporaryDirectories.push(temporaryDirectory);
  const workspace = await realpath(temporaryDirectory);

  return {
    workspace,
    configPath: join(workspace, "config", "itemd.json"),
  };
}

function storedConfiguration(apiKey = "working-secret") {
  return {
    version: ITEMD_CONFIG_VERSION,
    provider: "deepseek",
    model: "deepseek-flash",
    effort: "high",
    apiKey,
  } as const;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("TUI setup", () => {
  test("shows disabled providers and returns to provider selection", async () => {
    const { configPath } = await createTemporaryPaths();
    const io = new FakeTuiIO([
      "2",
      "1",
      "2",
      "4",
      "new-secret",
      "y",
      "serper-secret",
    ]);

    const result = await runSetup(io, {
      configPath,
      env: {},
    });

    expect(result).toEqual({ status: "saved" });
    expect(io.text()).toContain("OpenAI: Coming soon");
    expect(
      io.questions.filter(({ prompt }) => prompt === "Provider:  [1]: "),
    ).toHaveLength(2);
    expect(
      io.questions.find(({ prompt }) => prompt === "Model API key: ")?.options,
    ).toEqual({ masked: true });
    expect(
      io.questions.find(({ prompt }) => prompt === "Serper API key: ")?.options,
    ).toEqual({ masked: true });
    expect(io.text()).not.toContain("new-secret");
    expect(io.text()).not.toContain("serper-secret");

    const saved = await readConfiguration({ configPath, env: {} });
    expect(saved).toMatchObject({
      ok: true,
      configuration: {
        model: "deepseek-v4-pro",
        effort: "max",
        apiKey: "new-secret",
        webSearch: {
          enabled: true,
          serperApiKey: "serper-secret",
        },
      },
    });
  });

  test("cancels without writing partial configuration", async () => {
    const { configPath } = await createTemporaryPaths();
    const io = new FakeTuiIO(["1", "1", null]);

    await expect(
      runSetup(io, { configPath, env: {} }),
    ).resolves.toEqual({ status: "cancelled" });

    await expect(
      readConfiguration({ configPath, env: {} }),
    ).resolves.toEqual({
      ok: true,
      configuration: null,
      path: configPath,
    });
  });

  test("keeps a working configuration when reconfiguration is cancelled", async () => {
    const { configPath } = await createTemporaryPaths();
    await writeConfiguration(storedConfiguration(), {
      configPath,
      env: {},
    });
    const io = new FakeTuiIO(["1", null]);

    await expect(
      runSetup(io, { configPath, env: {} }),
    ).resolves.toEqual({ status: "cancelled" });

    const stored = await readConfiguration({ configPath, env: {} });
    expect(stored).toMatchObject({
      ok: true,
      configuration: storedConfiguration(),
    });
  });

  test("keeps current choices and credentials when Enter is pressed", async () => {
    const { configPath } = await createTemporaryPaths();
    await writeConfiguration(
      {
        ...storedConfiguration(),
        webSearch: {
          enabled: true,
          serperApiKey: "serper-secret",
        },
      },
      { configPath, env: {} },
    );
    const io = new FakeTuiIO(["", "", "", "", "", ""]);

    await expect(
      runSetup(io, { configPath, env: {} }),
    ).resolves.toEqual({ status: "saved" });

    const stored = await readConfiguration({ configPath, env: {} });
    expect(stored).toMatchObject({
      ok: true,
      configuration: {
        model: "deepseek-flash",
        effort: "high",
        apiKey: "working-secret",
        webSearch: {
          enabled: true,
          serperApiKey: "serper-secret",
        },
      },
    });
    expect(io.text()).not.toContain("working-secret");
    expect(io.text()).not.toContain("serper-secret");
  });
});

describe("TUI configuration flow", () => {
  test("runs first-use setup through injected input and output", async () => {
    const { workspace, configPath } = await createTemporaryPaths();
    const io = new FakeTuiIO([
      "1",
      "1",
      "3",
      "first-secret",
      "n",
      "/config",
      "/quit",
    ]);

    await runTui({
      io,
      workspaceRoot: workspace,
      config: { configPath, env: {} },
    });

    expect(io.closed).toBe(true);
    expect(io.text()).toContain("Configuration saved.");
    expect(io.text()).toContain("Active configuration:");
    expect(io.text()).toContain("provider: DeepSeek");
    expect(io.text()).not.toContain("first-secret");
  });

  test("exits cleanly when first-use setup is interrupted", async () => {
    const { workspace, configPath } = await createTemporaryPaths();
    const io = new FakeTuiIO(["1", "1", null]);

    await runTui({
      io,
      workspaceRoot: workspace,
      config: { configPath, env: {} },
    });

    expect(io.closed).toBe(true);
    expect(io.text()).toContain("Goodbye.");
    await expect(
      readConfiguration({ configPath, env: {} }),
    ).resolves.toEqual({
      ok: true,
      configuration: null,
      path: configPath,
    });
  });

  test("reruns setup from an active session", async () => {
    const { workspace, configPath } = await createTemporaryPaths();
    await writeConfiguration(storedConfiguration(), {
      configPath,
      env: {},
    });
    const io = new FakeTuiIO([
      "/adapter",
      "1",
      "2",
      "1",
      "replacement-secret",
      "n",
      "/quit",
    ]);

    await runTui({
      io,
      workspaceRoot: workspace,
      config: { configPath, env: {} },
    });

    const stored = await readConfiguration({ configPath, env: {} });
    expect(stored).toMatchObject({
      ok: true,
      configuration: {
        model: "deepseek-v4-pro",
        effort: "none",
        apiKey: "replacement-secret",
      },
    });
    expect(io.text()).not.toContain("replacement-secret");
  });

  test("reloads the active configuration without exposing its key", async () => {
    const { workspace, configPath } = await createTemporaryPaths();
    await writeConfiguration(storedConfiguration("reload-secret"), {
      configPath,
      env: {},
    });
    const io = new FakeTuiIO(["/reload", "/quit"]);

    await runTui({
      io,
      workspaceRoot: workspace,
      config: { configPath, env: {} },
    });

    expect(io.text()).toContain("Configuration reloaded.");
    expect(io.text()).toContain("model: deepseek-flash");
    expect(io.text()).not.toContain("reload-secret");
  });

  test("recovers from malformed stored configuration through setup", async () => {
    const { workspace, configPath } = await createTemporaryPaths();
    await mkdir(join(workspace, "config"), { recursive: true });
    await writeFile(configPath, "{broken", "utf8");
    const io = new FakeTuiIO([
      "1",
      "1",
      "3",
      "recovered-secret",
      "n",
      "/quit",
    ]);

    await runTui({
      io,
      workspaceRoot: workspace,
      config: { configPath, env: {} },
    });

    expect(io.text()).toContain("[configuration error]");
    expect(io.text()).toContain("Configuration saved.");
    expect(io.text()).not.toContain("recovered-secret");
  });

  test("lists and opens replays before exiting with exit()", async () => {
    const { workspace, configPath } = await createTemporaryPaths();
    await writeConfiguration(storedConfiguration(), {
      configPath,
      env: {},
    });
    const traceId = "12345678-1234-4123-8123-123456789abc";
    const traceDirectory = join(workspace, ".itemd", "traces");
    await mkdir(traceDirectory, { recursive: true });
    await writeFile(
      join(traceDirectory, `${traceId}.jsonl`),
      `${JSON.stringify({ type: "run_start", task: "example" })}\n`,
      "utf8",
    );
    const io = new FakeTuiIO([
      "/replays",
      "1",
      `/replay ${traceId}`,
      "exit()",
    ]);

    await runTui({
      io,
      workspaceRoot: workspace,
      config: { configPath, env: {} },
    });

    expect(io.closed).toBe(true);
    expect(io.text()).toContain("Select a replay (newest first):");
    expect(io.text()).toContain(traceId);
    expect(io.text()).toContain('"task": "example"');
    expect(io.text()).toContain("Goodbye.");
  });

  test("starts a new session without changing the active configuration", async () => {
    const { workspace, configPath } = await createTemporaryPaths();
    await writeConfiguration(storedConfiguration(), {
      configPath,
      env: {},
    });
    const io = new FakeTuiIO(["/new", "/quit"]);

    await runTui({
      io,
      workspaceRoot: workspace,
      config: { configPath, env: {} },
    });

    expect(io.text()).toContain(
      "New session started. Active configuration retained.",
    );
    expect(io.text()).toContain("provider: DeepSeek");
    await expect(readConfiguration({ configPath, env: {} })).resolves.toMatchObject({
      ok: true,
      configuration: storedConfiguration(),
    });
  });

  test("resumes a session for the current workspace", async () => {
    const { workspace, configPath } = await createTemporaryPaths();
    await writeConfiguration(storedConfiguration(), {
      configPath,
      env: {},
    });
    const sessionStore = await openSessionStore({
      dbPath: join(workspace, "config", "sessions.db"),
    });
    const session = sessionStore.createSession(workspace);
    sessionStore.appendMessage(session.id, {
      role: "user",
      content: "Previous task",
    });
    sessionStore.appendMessage(session.id, {
      role: "assistant",
      content: "Previous answer",
    });
    sessionStore.appendMessage(session.id, {
      role: "tool",
      toolCallId: "call-1",
      content: "Previous tool result",
    });
    sessionStore.close();

    const io = new FakeTuiIO(["/quit"]);
    await runTui({
      io,
      resumeSessionId: session.id,
      workspaceRoot: workspace,
      config: { configPath, env: {} },
    });

    expect(io.text()).toContain(`session: ${session.id}`);
    expect(io.text()).toContain("Restored session history:");
    expect(io.text()).toContain("you: Previous task");
    expect(io.text()).toContain("assistant: Previous answer");
    expect(io.text()).toContain("tool: call-1: Previous tool result");
    expect(io.text()).not.toContain("[session error]");
  });
});
