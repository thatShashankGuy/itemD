import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getConfigurationPath,
  ITEMD_CONFIG_VERSION,
  readConfiguration,
  resolveConfiguration,
  validateConfiguration,
  writeConfiguration,
} from "../src/config/configuration.ts";

const temporaryDirectories: string[] = [];

async function createConfigPath(): Promise<{
  directory: string;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "itemd-config-test-"));
  temporaryDirectories.push(directory);

  return {
    directory,
    path: join(directory, "nested", "config.json"),
  };
}

function validConfiguration(apiKey = "stored-secret") {
  return {
    version: ITEMD_CONFIG_VERSION,
    provider: "deepseek",
    model: "deepseek-flash",
    effort: "high",
    apiKey,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("configuration paths and reads", () => {
  test("uses an explicit path without consulting the user directory", async () => {
    const { path } = await createConfigPath();

    expect(getConfigurationPath({ configPath: path, env: {} })).toBe(path);
    expect(
      getConfigurationPath({
        env: { ITEMD_CONFIG_PATH: path },
      }),
    ).toBe(path);
  });

  test("treats a missing configuration as first-run state", async () => {
    const { path } = await createConfigPath();

    await expect(
      readConfiguration({ configPath: path, env: {} }),
    ).resolves.toEqual({
      ok: true,
      configuration: null,
      path,
    });
  });

  test("returns a recoverable parse error for malformed JSON", async () => {
    const { directory, path } = await createConfigPath();
    await writeFile(join(directory, "broken.json"), "{not-json}", "utf8");
    const brokenPath = join(directory, "broken.json");

    const result = await readConfiguration({
      configPath: brokenPath,
      env: {},
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CONFIG_PARSE_FAILED",
        message: "The itemD configuration is not valid JSON",
      },
      path: brokenPath,
    });
    expect(path).not.toBe(brokenPath);
  });

  test("returns a structured error when the file cannot be read", async () => {
    const { directory } = await createConfigPath();
    const result = await readConfiguration({
      configPath: directory,
      env: {},
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONFIG_READ_FAILED" },
    });
  });
});

describe("configuration validation", () => {
  test("keeps only known fields after parsing unknown input", () => {
    const result = validateConfiguration({
      ...validConfiguration(),
      ignored: "value",
    });

    expect(result).toEqual({
      ok: true,
      configuration: validConfiguration(),
    });
  });

  test("rejects disabled providers and incompatible choices", () => {
    expect(
      validateConfiguration({
        ...validConfiguration(),
        provider: "openai",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONFIG_VALIDATION_FAILED" },
    });

    expect(
      validateConfiguration({
        ...validConfiguration(),
        model: "unknown-model",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONFIG_VALIDATION_FAILED" },
    });
  });

  test("never includes a submitted API key in validation errors", () => {
    const apiKey = `secret-${randomUUID()}`;
    const result = validateConfiguration({
      ...validConfiguration(apiKey),
      effort: "unsupported",
    });

    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  test("validates optional Serper web-search configuration", () => {
    const result = validateConfiguration({
      ...validConfiguration(),
      webSearch: {
        enabled: true,
        serperApiKey: "serper-secret",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      configuration: {
        webSearch: {
          enabled: true,
          serperApiKey: "serper-secret",
        },
      },
    });

    expect(
      validateConfiguration({
        ...validConfiguration(),
        webSearch: { enabled: true, serperApiKey: "" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONFIG_VALIDATION_FAILED" },
    });
  });
});

describe("configuration writes", () => {
  test("creates parents and atomically writes a user-only file", async () => {
    const { directory, path } = await createConfigPath();
    const result = await writeConfiguration(validConfiguration(), {
      configPath: path,
      env: {},
    });

    expect(result).toMatchObject({ ok: true, path });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
      validConfiguration(),
    );
    expect(await readdir(join(directory, "nested"))).toEqual([
      "config.json",
    ]);

    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("does not write invalid input or leak its credential", async () => {
    const { path } = await createConfigPath();
    const apiKey = `secret-${randomUUID()}`;
    const result = await writeConfiguration(
      { ...validConfiguration(apiKey), version: 2 },
      { configPath: path, env: {} },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONFIG_VALIDATION_FAILED" },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  test("returns a structured write error without leaking the key", async () => {
    const { directory } = await createConfigPath();
    const blockingFile = join(directory, "not-a-directory");
    const apiKey = `secret-${randomUUID()}`;
    await writeFile(blockingFile, "blocking file", "utf8");

    const result = await writeConfiguration(
      validConfiguration(apiKey),
      {
        configPath: join(blockingFile, "config.json"),
        env: {},
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONFIG_WRITE_FAILED" },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
});

describe("environment overrides", () => {
  test("supports environment-only DeepSeek configuration", async () => {
    const { path } = await createConfigPath();
    const result = await resolveConfiguration({
      configPath: path,
      env: { DEEPSEEK_API_KEY: "environment-secret" },
    });

    expect(result).toMatchObject({
      ok: true,
      configuration: {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
        apiKey: "environment-secret",
      },
    });
  });

  test("environment values override stored model, effort, and key", async () => {
    const { path } = await createConfigPath();
    await writeConfiguration(validConfiguration(), {
      configPath: path,
      env: {},
    });

    const result = await resolveConfiguration({
      configPath: path,
      env: {
        DEEPSEEK_API_KEY: "environment-secret",
        DEEPSEEK_MODEL: "deepseek-v4-pro",
        DEEPSEEK_REASONING_EFFORT: "max",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      configuration: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effort: "max",
        apiKey: "environment-secret",
      },
    });
  });

  test("enables web search from an environment Serper key", async () => {
    const { path } = await createConfigPath();
    const result = await resolveConfiguration({
      configPath: path,
      env: {
        DEEPSEEK_API_KEY: "environment-secret",
        SERPER_API_KEY: "serper-secret",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      configuration: {
        webSearch: {
          enabled: true,
          serperApiKey: "serper-secret",
        },
      },
    });
  });
});
