import {
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runAgent } from "../src/agent/runner.ts";
import type { ModelAdapter } from "../src/model/adapter.ts";
import { createModelAdapter } from "../src/model/factory.ts";
import type { ModelMessage } from "../src/model/types.ts";

const temporaryDirectories: string[] = [];

function responseFetch(
  body: unknown,
  inspect?: (init: RequestInit | undefined) => void,
): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    inspect?.(init);

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function finalResponse(text = "DONE: complete") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

function createDeepSeek(
  effort: string,
  fetchImplementation: typeof fetch,
) {
  return createModelAdapter(
    {
      provider: "deepseek",
      model: "deepseek-flash",
      effort,
      apiKey: "test-secret",
    },
    { fetchImplementation },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("model adapter factory", () => {
  test.each([
    ["unknown", "UNKNOWN_PROVIDER"],
    ["openai", "PROVIDER_DISABLED"],
  ])("rejects non-executable provider %s", (provider, code) => {
    const result = createModelAdapter({
      provider,
      model: "deepseek-flash",
      effort: "high",
      apiKey: "test-secret",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  test("rejects missing credentials without creating an adapter", () => {
    const result = createModelAdapter({
      provider: "deepseek",
      model: "deepseek-flash",
      effort: "high",
      apiKey: "",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "MISSING_API_KEY" },
    });
  });
});

describe("DeepSeek adapter requests", () => {
  test.each([
    ["none", "disabled", undefined],
    ["low", "enabled", "low"],
    ["high", "enabled", "high"],
    ["max", "enabled", "max"],
  ])(
    "maps %s effort to DeepSeek request parameters",
    async (effort, thinkingType, reasoningEffort) => {
      let requestBody: Record<string, unknown> | undefined;
      const result = createDeepSeek(
        effort,
        responseFetch(finalResponse(), (init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
        }),
      );

      expect(result.ok).toBe(true);

      if (!result.ok) {
        return;
      }

      await result.adapter.call([{ role: "user", content: "task" }]);

      expect(requestBody).toMatchObject({
        model: "deepseek-flash",
        thinking: { type: thinkingType },
      });
      expect(requestBody?.reasoning_effort).toBe(reasoningEffort);
    },
  );

  test("preserves reasoning and tool-call IDs across tool turns", async () => {
    let requestBody: { messages?: unknown[] } | undefined;
    const result = createDeepSeek(
      "high",
      responseFetch(finalResponse(), (init) => {
        requestBody = JSON.parse(String(init?.body)) as {
          messages?: unknown[];
        };
      }),
    );

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const history: ModelMessage[] = [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: null,
        reasoning: "I should read the file",
        toolCalls: [
          {
            id: "call_123",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_123",
        content: '{"output":"contents"}',
      },
    ];

    await result.adapter.call(history);

    expect(requestBody?.messages).toContainEqual({
      role: "assistant",
      content: null,
      reasoning_content: "I should read the file",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        },
      ],
    });
    expect(requestBody?.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_123",
      content: '{"output":"contents"}',
    });
  });

  test("returns a structured error for a malformed provider response", async () => {
    const result = createDeepSeek(
      "high",
      responseFetch({ choices: [] }),
    );

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    await expect(
      result.adapter.call([{ role: "user", content: "task" }]),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_MODEL_RESPONSE" },
    });
  });

  test("redacts the API key from transport failures", async () => {
    const fetchImplementation = (async () => {
      throw new Error("transport failed for test-secret");
    }) as typeof fetch;
    const result = createDeepSeek("high", fetchImplementation);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const callResult = await result.adapter.call([
      { role: "user", content: "task" },
    ]);

    expect(callResult).toMatchObject({
      ok: false,
      error: { code: "MODEL_REQUEST_FAILED" },
    });
    expect(JSON.stringify(callResult)).not.toContain("test-secret");
  });
});

describe("provider-neutral runner", () => {
  test("records adapter metadata without credentials", async () => {
    const temporaryWorkspace = await mkdtemp(
      join(tmpdir(), "itemd-adapter-test-"),
    );
    temporaryDirectories.push(temporaryWorkspace);
    const workspace = await realpath(temporaryWorkspace);
    const adapter: ModelAdapter = {
      metadata: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effort: "max",
      },
      async call() {
        return {
          ok: true,
          message: {
            role: "assistant",
            content: "DONE: complete",
          },
          action: { type: "final", text: "DONE: complete" },
        };
      },
    };

    const result = await runAgent("task", adapter, workspace);

    expect(result.ok).toBe(true);
    const tracePath = join(workspace, result.tracePath);
    const trace = await readFile(tracePath, "utf8");
    const firstEvent = JSON.parse(trace.split("\n")[0] ?? "null");

    expect(firstEvent).toMatchObject({
      type: "run_start",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      effort: "max",
    });
    expect(trace).not.toContain("apiKey");
    expect(trace).not.toContain("test-secret");
  });
});
