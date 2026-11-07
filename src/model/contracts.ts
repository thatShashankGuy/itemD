export const PROVIDER_IDS = [
  "deepseek",
  "openai",
  "openrouter",
  "anthropic",
  "gemini",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const REASONING_EFFORTS = [
  "none",
  "low",
  "high",
  "max",
] as const;

export type ReasoningEffort =
  (typeof REASONING_EFFORTS)[number];

export type ModelDefinition = {
  id: string;
  displayName: string;
};

export type ReasoningEffortDefinition = {
  id: ReasoningEffort;
  displayName: string;
};

export type EnabledProviderDefinition = {
  id: ProviderId;
  displayName: string;
  enabled: true;
  models: readonly ModelDefinition[];
  reasoningEfforts: readonly ReasoningEffortDefinition[];
  defaultModel: string;
  defaultEffort: ReasoningEffort;
};

export type DisabledProviderDefinition = {
  id: ProviderId;
  displayName: string;
  enabled: false;
  disabledMessage: string;
};

export type ProviderDefinition =
  | EnabledProviderDefinition
  | DisabledProviderDefinition;

export type ProviderSelection = {
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
};

export type ProviderSelectionError = {
  code:
    | "UNKNOWN_PROVIDER"
    | "PROVIDER_DISABLED"
    | "UNSUPPORTED_MODEL"
    | "UNSUPPORTED_REASONING_EFFORT";
  message: string;
};

export type ProviderSelectionResult =
  | {
      ok: true;
      selection: ProviderSelection;
      provider: EnabledProviderDefinition;
    }
  | {
      ok: false;
      error: ProviderSelectionError;
    };
