import type {
  ModelAdapterConfiguration,
  ModelAdapterFactoryResult,
} from "./adapter.ts";
import { createDeepSeekAdapter } from "./adapters/deepseek.ts";
import { validateProviderSelection } from "./catalog.ts";

export type ModelAdapterDependencies = {
  fetchImplementation?: typeof fetch;
};

export function createModelAdapter(
  configuration: ModelAdapterConfiguration,
  dependencies: ModelAdapterDependencies = {},
): ModelAdapterFactoryResult {
  const selection = validateProviderSelection(configuration);

  if (!selection.ok) {
    return { ok: false, error: selection.error };
  }

  if (
    typeof configuration.apiKey !== "string" ||
    configuration.apiKey.length === 0
  ) {
    return {
      ok: false,
      error: {
        code: "MISSING_API_KEY",
        message: "Model configuration must include an API key",
      },
    };
  }

  if (selection.selection.provider === "deepseek") {
    return {
      ok: true,
      adapter: createDeepSeekAdapter({
        apiKey: configuration.apiKey,
        model: selection.selection.model,
        effort: selection.selection.effort,
        ...(dependencies.fetchImplementation === undefined
          ? {}
          : { fetchImplementation: dependencies.fetchImplementation }),
      }),
    };
  }

  return {
    ok: false,
    error: {
      code: "ADAPTER_UNAVAILABLE",
      message: `No adapter is available for ${selection.provider.displayName}`,
    },
  };
}
