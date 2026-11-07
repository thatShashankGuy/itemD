import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_DEEPSEEK_MODEL,
  PROVIDER_CATALOG,
  validateProviderSelection,
} from "../model/catalog.ts";
import type {
  ProviderId,
  ReasoningEffort,
} from "../model/contracts.ts";
import { isRecord } from "../shared/runtime.ts";

export const ITEMD_CONFIG_VERSION = 1;
const CONFIG_FILE_NAME = "config.json";
const CONFIG_DIRECTORY_NAME = "itemd";
const DEFAULT_DEEPSEEK_EFFORT =
  PROVIDER_CATALOG[0].defaultEffort;

export type ItemDConfiguration = {
  version: typeof ITEMD_CONFIG_VERSION;
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
  apiKey: string;
};

export type ConfigurationError = {
  code:
    | "CONFIG_READ_FAILED"
    | "CONFIG_PARSE_FAILED"
    | "CONFIG_VALIDATION_FAILED"
    | "CONFIG_WRITE_FAILED";
  message: string;
};

export type ConfigurationResult =
  | {
      ok: true;
      configuration: ItemDConfiguration | null;
      path: string;
    }
  | {
      ok: false;
      error: ConfigurationError;
      path: string;
    };

export type WriteConfigurationResult =
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      error: ConfigurationError;
      path: string;
    };

export type ConfigurationOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
};

function defaultConfigDirectory(
  env: NodeJS.ProcessEnv,
): string {
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, CONFIG_DIRECTORY_NAME);
  }

  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      CONFIG_DIRECTORY_NAME,
    );
  }

  const baseDirectory =
    env.XDG_CONFIG_HOME ?? join(homedir(), ".config");

  return join(baseDirectory, CONFIG_DIRECTORY_NAME);
}

export function getConfigurationPath(
  options: ConfigurationOptions = {},
): string {
  const env = options.env ?? process.env;
  const configuredPath =
    options.configPath ?? env.ITEMD_CONFIG_PATH;

  return resolve(
    configuredPath ??
      join(defaultConfigDirectory(env), CONFIG_FILE_NAME),
  );
}

function validationError(message: string): ConfigurationError {
  return {
    code: "CONFIG_VALIDATION_FAILED",
    message,
  };
}

export function validateConfiguration(
  value: unknown,
):
  | { ok: true; configuration: ItemDConfiguration }
  | { ok: false; error: ConfigurationError } {
  if (
    !isRecord(value) ||
    value.version !== ITEMD_CONFIG_VERSION
  ) {
    return {
      ok: false,
      error: validationError(
        `Configuration version must be ${ITEMD_CONFIG_VERSION}`,
      ),
    };
  }

  const selection = validateProviderSelection(value);

  if (!selection.ok) {
    return {
      ok: false,
      error: validationError(selection.error.message),
    };
  }

  if (typeof value.apiKey !== "string" || value.apiKey.length === 0) {
    return {
      ok: false,
      error: validationError("Configuration must include an API key"),
    };
  }

  return {
    ok: true,
    configuration: {
      version: ITEMD_CONFIG_VERSION,
      provider: selection.selection.provider,
      model: selection.selection.model,
      effort: selection.selection.effort,
      apiKey: value.apiKey,
    },
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    isRecord(error) &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function readConfiguration(
  options: ConfigurationOptions = {},
): Promise<ConfigurationResult> {
  const path = getConfigurationPath(options);
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return { ok: true, configuration: null, path };
    }

    return {
      ok: false,
      error: {
        code: "CONFIG_READ_FAILED",
        message: "Unable to read the itemD configuration",
      },
      path,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      error: {
        code: "CONFIG_PARSE_FAILED",
        message: "The itemD configuration is not valid JSON",
      },
      path,
    };
  }

  const validated = validateConfiguration(parsed);

  return validated.ok
    ? { ok: true, configuration: validated.configuration, path }
    : { ok: false, error: validated.error, path };
}

export async function writeConfiguration(
  value: unknown,
  options: ConfigurationOptions = {},
): Promise<WriteConfigurationResult> {
  const path = getConfigurationPath(options);
  const validated = validateConfiguration(value);

  if (!validated.ok) {
    return { ok: false, error: validated.error, path };
  }

  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`,
  );
  let temporaryFileCreated = false;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryFileCreated = true;

    try {
      await handle.writeFile(
        `${JSON.stringify(validated.configuration, null, 2)}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, path);
    temporaryFileCreated = false;

    return {
      ok: true,
      path,
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "CONFIG_WRITE_FAILED",
        message: "Unable to save the itemD configuration",
      },
      path,
    };
  } finally {
    if (temporaryFileCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function resolveConfiguration(
  options: ConfigurationOptions = {},
): Promise<ConfigurationResult> {
  const storedResult = await readConfiguration(options);

  if (!storedResult.ok) {
    return storedResult;
  }

  const env = options.env ?? process.env;
  const stored = storedResult.configuration;
  const environmentApiKey = env.DEEPSEEK_API_KEY;
  const apiKey = environmentApiKey ?? stored?.apiKey;

  if (apiKey === undefined || apiKey.length === 0) {
    return {
      ok: true,
      configuration: null,
      path: storedResult.path,
    };
  }

  const candidate = {
    version: ITEMD_CONFIG_VERSION,
    provider: "deepseek",
    model:
      env.DEEPSEEK_MODEL ??
      stored?.model ??
      DEFAULT_DEEPSEEK_MODEL,
    effort:
      env.DEEPSEEK_REASONING_EFFORT ??
      stored?.effort ??
      DEFAULT_DEEPSEEK_EFFORT,
    apiKey,
  };
  const validated = validateConfiguration(candidate);

  return validated.ok
    ? {
        ok: true,
        configuration: validated.configuration,
        path: storedResult.path,
      }
    : {
        ok: false,
        error: validated.error,
        path: storedResult.path,
      };
}
