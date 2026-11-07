import type { ProviderSelectionError } from "./contracts.ts";
import type {
  ModelCallResult,
  ModelMessage,
  ModelMetadata,
} from "./types.ts";

export interface ModelAdapter {
  readonly metadata: ModelMetadata;
  call(
    history: readonly ModelMessage[],
    signal?: AbortSignal,
  ): Promise<ModelCallResult>;
}

export type ModelAdapterConfiguration = {
  provider: unknown;
  model: unknown;
  effort: unknown;
  apiKey: unknown;
};

export type ModelAdapterFactoryError =
  | ProviderSelectionError
  | { code: "MISSING_API_KEY"; message: string }
  | { code: "ADAPTER_UNAVAILABLE"; message: string };

export type ModelAdapterFactoryResult =
  | { ok: true; adapter: ModelAdapter }
  | { ok: false; error: ModelAdapterFactoryError };
