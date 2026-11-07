import { isRecord } from "../shared/runtime.ts";
import type {
  EnabledProviderDefinition,
  ProviderDefinition,
  ProviderSelectionResult,
  ReasoningEffort,
} from "./contracts.ts";

export const PROVIDER_CATALOG = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    enabled: true,
    models: [
      {
        id: "deepseek-flash",
        displayName: "DeepSeek Flash",
      },
      {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
      },
    ],
    reasoningEfforts: [
      { id: "none", displayName: "Off" },
      { id: "low", displayName: "Low" },
      { id: "high", displayName: "High" },
      { id: "max", displayName: "Max" },
    ],
    defaultModel: "deepseek-flash",
    defaultEffort: "high",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    enabled: false,
    disabledMessage: "Coming soon",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    enabled: false,
    disabledMessage: "Coming soon",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    enabled: false,
    disabledMessage: "Coming soon",
  },
  {
    id: "gemini",
    displayName: "Gemini",
    enabled: false,
    disabledMessage: "Coming soon",
  },
] as const satisfies readonly ProviderDefinition[];

export const DEFAULT_DEEPSEEK_MODEL =
  PROVIDER_CATALOG[0].defaultModel;

export function getProviderDefinition(
  providerId: string,
): ProviderDefinition | undefined {
  return PROVIDER_CATALOG.find(
    (provider) => provider.id === providerId,
  );
}

function supportsModel(
  provider: EnabledProviderDefinition,
  model: string,
): boolean {
  return provider.models.some((candidate) => candidate.id === model);
}

function supportsEffort(
  provider: EnabledProviderDefinition,
  effort: string,
): effort is ReasoningEffort {
  return provider.reasoningEfforts.some(
    (candidate) => candidate.id === effort,
  );
}

export function validateProviderSelection(
  value: unknown,
): ProviderSelectionResult {
  if (!isRecord(value) || typeof value.provider !== "string") {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_PROVIDER",
        message: "Provider selection must include a supported provider ID",
      },
    };
  }

  const provider = getProviderDefinition(value.provider);

  if (provider === undefined) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_PROVIDER",
        message: `Unsupported provider: ${value.provider}`,
      },
    };
  }

  if (!provider.enabled) {
    return {
      ok: false,
      error: {
        code: "PROVIDER_DISABLED",
        message: `${provider.displayName}: ${provider.disabledMessage}`,
      },
    };
  }

  if (
    typeof value.model !== "string" ||
    !supportsModel(provider, value.model)
  ) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_MODEL",
        message: `Model is not supported by ${provider.displayName}`,
      },
    };
  }

  if (
    typeof value.effort !== "string" ||
    !supportsEffort(provider, value.effort)
  ) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_REASONING_EFFORT",
        message: `Reasoning effort is not supported by ${provider.displayName}`,
      },
    };
  }

  return {
    ok: true,
    selection: {
      provider: provider.id,
      model: value.model,
      effort: value.effort,
    },
    provider,
  };
}
