import { describe, expect, test } from "vitest";
import { executeTool } from "../src/tools/dispatcher.ts";
import { validateWebFetchUrl } from "../src/permissions/web-policy.ts";
import { createSerperSearchProvider } from "../src/web/provider.ts";

function jsonFetch(
  body: unknown,
  inspect?: (url: string | URL | Request, init?: RequestInit) => void,
): typeof fetch {
  return (async (url, init) => {
    inspect?.(url, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("Serper search provider", () => {
  test("sends the key and normalizes to five compact search results", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    let requestHeaders: Headers | undefined;

    const provider = createSerperSearchProvider({
      apiKey: "serper-secret",
      fetchImplementation: jsonFetch(
        {
          organic: [
            ...Array.from({ length: 6 }, (_, index) => ({
              title: ` Result ${index + 1} `,
              link: `https://example.com/${index + 1}`,
              snippet: ` snippet ${index + 1} `,
              position: index + 1,
            })),
            { title: "missing link" },
          ],
          searchParameters: { q: "ignored raw response" },
        },
        (url, init) => {
          requestUrl = String(url);
          requestBody = JSON.parse(String(init?.body));
          requestHeaders = new Headers(init?.headers);
        },
      ),
    });

    const result = await provider.search("Bun worker_threads");

    expect(result).toEqual({
      ok: true,
      output: {
        query: "Bun worker_threads",
        results: [1, 2, 3, 4, 5].map((index) => ({
          title: `Result ${index}`,
          url: `https://example.com/${index}`,
          snippet: `snippet ${index}`,
        })),
      },
    });
    expect(requestUrl).toBe("https://google.serper.dev/search");
    expect(requestBody).toEqual({
      q: "Bun worker_threads",
      num: 5,
    });
    expect(requestHeaders?.get("X-API-KEY")).toBe("serper-secret");
  });

  test("bounds fetched page text and never returns the API key", async () => {
    const apiKey = "serper-secret";
    const provider = createSerperSearchProvider({
      apiKey,
      fetchImplementation: jsonFetch({
        title: " Bun docs ",
        text: `${"word ".repeat(5_000)} ${apiKey}`,
      }),
    });

    const result = await provider.fetch("https://bun.sh/docs");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.output.url).toBe("https://bun.sh/docs");
      expect(result.output.title).toBe("Bun docs");
      expect(result.output.text.length).toBeLessThanOrEqual(20_000);
      expect(result.output.truncated).toBe(true);
      expect(JSON.stringify(result)).not.toContain(apiKey);
    }
  });

  test("redacts provider credentials from request failures", async () => {
    const apiKey = "serper-secret";
    const provider = createSerperSearchProvider({
      apiKey,
      fetchImplementation: (async () => {
        throw new Error(`network failed for ${apiKey}`);
      }) as typeof fetch,
    });

    const result = await provider.search("query");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "REQUEST_FAILED" },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
});

describe("web tool policy and dispatcher", () => {
  test.each([
    "http://localhost:3000/private",
    "http://127.0.0.1/private",
    "http://192.168.1.2/private",
    "https://user:password@example.com/private",
    "file:///tmp/secret",
  ])("rejects unsafe fetch URL %s", (url) => {
    expect(validateWebFetchUrl(url)).toMatchObject({ ok: false });
  });

  test("returns a structured disabled result without a provider", async () => {
    await expect(
      executeTool(
        { type: "web_search", query: "Bun worker_threads" },
        "/tmp",
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "WEB_SEARCH_DISABLED",
        message:
          "Web search is disabled. Enable it and configure a Serper API key first.",
      },
    });
  });

  test("dispatches both web tools through the configured provider", async () => {
    const calls: string[] = [];
    const provider = {
      async search(query: string) {
        calls.push(`search:${query}`);
        return {
          ok: true as const,
          output: {
            query,
            results: [],
          },
        };
      },
      async fetch(url: string) {
        calls.push(`fetch:${url}`);
        return {
          ok: true as const,
          output: {
            url,
            text: "page text",
            truncated: false,
          },
        };
      },
    };

    await expect(
      executeTool(
        { type: "web_search", query: "query" },
        "/tmp",
        undefined,
        { webSearchProvider: provider },
      ),
    ).resolves.toMatchObject({ ok: true, output: { results: [] } });
    await expect(
      executeTool(
        { type: "web_fetch", url: "https://example.com/docs" },
        "/tmp",
        undefined,
        { webSearchProvider: provider },
      ),
    ).resolves.toMatchObject({ ok: true, output: { text: "page text" } });
    expect(calls).toEqual([
      "search:query",
      "fetch:https://example.com/docs",
    ]);
  });
});
