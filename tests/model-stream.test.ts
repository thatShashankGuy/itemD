import { describe, expect, test } from "vitest";
import { createDeepSeekAdapter } from "../src/model/adapters/deepseek.ts";
import type { ModelStreamEvent } from "../src/model/types.ts";

function streamFetch(
  chunks: string[],
  inspect?: (init: RequestInit | undefined) => void,
): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    inspect?.(init);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
}

async function collect(
  events: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const collected: ModelStreamEvent[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

function eventData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

describe("DeepSeek model streaming adapter", () => {
  test("forwards text and reasoning deltas before the completed result", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const adapter = createDeepSeekAdapter({
      apiKey: "test-secret",
      model: "deepseek-flash",
      effort: "high",
      fetchImplementation: streamFetch(
        [
          eventData({
            choices: [{ delta: { role: "assistant", content: "The " } }],
          }),
          eventData({
            choices: [{ delta: { reasoning_content: "check files" } }],
          }),
          eventData({
            choices: [{ delta: { content: "build is failing." } }],
          }),
          "data: [DONE]\n\n",
        ],
        (init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
        },
      ),
    });

    const events = await collect(
      adapter.stream!([{ role: "user", content: "Why?" }]),
    );

    expect(requestBody).toMatchObject({
      model: "deepseek-flash",
      stream: true,
    });
    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "reasoning_delta",
      "text_delta",
      "completed",
    ]);
    expect(events[0]).toEqual({ type: "text_delta", text: "The " });
    expect(events[1]).toEqual({
      type: "reasoning_delta",
      text: "check files",
    });
    expect(events[3]).toMatchObject({
      type: "completed",
      result: {
        ok: true,
        message: {
          content: "The build is failing.",
          reasoning: "check files",
        },
      },
    });
  });

  test("accumulates split tool-call arguments into the normal model result", async () => {
    const adapter = createDeepSeekAdapter({
      apiKey: "test-secret",
      model: "deepseek-flash",
      effort: "high",
      fetchImplementation: streamFetch([
        eventData({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"',
                },
              }],
            },
          }],
        }),
        eventData({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: "README.md\"}" },
              }],
            },
          }],
        }),
        "data: [DONE]\n\n",
      ]),
    });

    const events = await collect(
      adapter.stream!([{ role: "user", content: "read" }]),
    );
    const completed = events.at(-1);

    expect(completed).toMatchObject({
      type: "completed",
      result: {
        ok: true,
        action: {
          type: "tool_calls",
          calls: [{
            id: "call-1",
            name: "read_file",
            args: { path: "README.md" },
          }],
        },
      },
    });
  });

  test("turns malformed SSE data into a failed stream event", async () => {
    const adapter = createDeepSeekAdapter({
      apiKey: "test-secret",
      model: "deepseek-flash",
      effort: "high",
      fetchImplementation: streamFetch(["data: {not-json}\n\n"]),
    });

    await expect(
      collect(adapter.stream!([{ role: "user", content: "task" }])),
    ).resolves.toMatchObject([
      { type: "failed", error: { code: "INVALID_MODEL_RESPONSE" } },
    ]);
  });
});
