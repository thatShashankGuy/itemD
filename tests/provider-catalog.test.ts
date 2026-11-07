import { describe, expect, test } from "vitest";
import {
  PROVIDER_CATALOG,
  validateProviderSelection,
} from "../src/model/catalog.ts";

describe("provider catalog", () => {
  test("describes DeepSeek defaults and supported choices", () => {
    const deepSeek = PROVIDER_CATALOG.find(
      (provider) => provider.id === "deepseek",
    );

    expect(deepSeek).toMatchObject({
      enabled: true,
      defaultModel: "deepseek-flash",
      defaultEffort: "high",
    });

    if (deepSeek?.enabled) {
      expect(deepSeek.models.map((model) => model.id)).toEqual([
        "deepseek-flash",
        "deepseek-v4-pro",
      ]);
      expect(
        deepSeek.reasoningEfforts.map((effort) => effort.id),
      ).toEqual(["none", "low", "high", "max"]);
    }
  });

  test("keeps unavailable providers visible and disabled", () => {
    const disabledProviders = PROVIDER_CATALOG.filter(
      (provider) => !provider.enabled,
    );

    expect(disabledProviders).toHaveLength(4);
    expect(
      disabledProviders.map((provider) => provider.id),
    ).toEqual(["openai", "openrouter", "anthropic", "gemini"]);
    expect(
      disabledProviders.every(
        (provider) => provider.disabledMessage === "Coming soon",
      ),
    ).toBe(true);
  });
});

describe("provider selection validation", () => {
  test("accepts an enabled provider with compatible choices", () => {
    const result = validateProviderSelection({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      effort: "max",
    });

    expect(result).toMatchObject({
      ok: true,
      selection: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effort: "max",
      },
    });
  });

  test("rejects a disabled provider before accepting its settings", () => {
    const result = validateProviderSelection({
      provider: "openai",
      model: "deepseek-flash",
      effort: "high",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PROVIDER_DISABLED",
        message: "OpenAI: Coming soon",
      },
    });
  });

  test("rejects an unknown provider", () => {
    const result = validateProviderSelection({
      provider: "unknown",
      model: "deepseek-flash",
      effort: "high",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_PROVIDER" },
    });
  });

  test.each([
    {
      selection: {
        provider: "deepseek",
        model: "unsupported-model",
        effort: "high",
      },
      code: "UNSUPPORTED_MODEL",
    },
    {
      selection: {
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "medium",
      },
      code: "UNSUPPORTED_REASONING_EFFORT",
    },
  ])("rejects incompatible selections with $code", ({ selection, code }) => {
    const result = validateProviderSelection(selection);

    expect(result).toMatchObject({
      ok: false,
      error: { code },
    });
  });
});
