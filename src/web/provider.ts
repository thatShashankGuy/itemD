import { isRecord } from "../shared/runtime.ts";

const SEARCH_ENDPOINT = "https://google.serper.dev/search";
const FETCH_ENDPOINT = "https://scrape.serper.dev/";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SEARCH_RESULTS = 5;
const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 1_200;
const MAX_PAGE_TEXT_CHARS = 20_000;

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchOutput = {
  query: string;
  results: WebSearchResult[];
};

export type WebFetchOutput = {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
};

export type SearchProviderError = {
  code: "REQUEST_FAILED" | "INVALID_RESPONSE";
  message: string;
  status?: number;
};

export type SearchProviderResult<T> =
  | { ok: true; output: T }
  | { ok: false; error: SearchProviderError };

export interface SearchProvider {
  search(
    query: string,
    signal?: AbortSignal,
  ): Promise<SearchProviderResult<WebSearchOutput>>;
  fetch(
    url: string,
    signal?: AbortSignal,
  ): Promise<SearchProviderResult<WebFetchOutput>>;
}

export type SerperSearchProviderOptions = {
  apiKey: string;
  fetchImplementation?: typeof fetch;
};

function getRequestSignal(signal?: AbortSignal): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  return {
    signal:
      signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, signal]),
    cancel: () => clearTimeout(timeout),
  };
}

function cleanText(value: string, maxChars: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function redactSecret(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join("[REDACTED]");
}

function providerFailure(
  operation: string,
  status?: number,
): SearchProviderResult<never> {
  return {
    ok: false,
    error: {
      code: "REQUEST_FAILED",
      message:
        status === undefined
          ? `Serper ${operation} request failed`
          : `Serper ${operation} request failed with HTTP ${status}`,
      ...(status === undefined ? {} : { status }),
    },
  };
}

function invalidProviderResponse(
  operation: string,
): SearchProviderResult<never> {
  return {
    ok: false,
    error: {
      code: "INVALID_RESPONSE",
      message: `Serper ${operation} response was invalid`,
    },
  };
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function normalizeSearchResponse(
  query: string,
  apiKey: string,
  body: unknown,
): SearchProviderResult<WebSearchOutput> {
  if (!isRecord(body) || !Array.isArray(body.organic)) {
    return invalidProviderResponse("search");
  }

  const results: WebSearchResult[] = [];

  for (const item of body.organic) {
    if (!isRecord(item)) {
      continue;
    }

    const title = getString(item, "title");
    const url = getString(item, "link");

    if (title === undefined || url === undefined) {
      continue;
    }

    results.push({
      title: redactSecret(cleanText(title, MAX_TITLE_CHARS), apiKey),
      url: redactSecret(url, apiKey),
      snippet: redactSecret(
        cleanText(getString(item, "snippet") ?? "", MAX_SNIPPET_CHARS),
        apiKey,
      ),
    });

    if (results.length === MAX_SEARCH_RESULTS) {
      break;
    }
  }

  return {
    ok: true,
    output: { query, results },
  };
}

function normalizeFetchResponse(
  url: string,
  apiKey: string,
  body: unknown,
): SearchProviderResult<WebFetchOutput> {
  if (!isRecord(body)) {
    return invalidProviderResponse("fetch");
  }

  const text = ["text", "markdown", "content", "body"]
    .map((key) => getString(body, key))
    .find((value) => value !== undefined);

  if (text === undefined) {
    return invalidProviderResponse("fetch");
  }

  const normalizedText = redactSecret(
    cleanText(text, MAX_PAGE_TEXT_CHARS),
    apiKey,
  );

  return {
    ok: true,
    output: {
      url: redactSecret(url, apiKey),
      ...(typeof body.title === "string"
        ? {
            title: redactSecret(
              cleanText(body.title, MAX_TITLE_CHARS),
              apiKey,
            ),
          }
        : {}),
      text: normalizedText,
      truncated: text.length > cleanText(text, MAX_PAGE_TEXT_CHARS).length,
    },
  };
}

async function requestJson(
  endpoint: string,
  operation: string,
  apiKey: string,
  body: Record<string, unknown>,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<SearchProviderResult<unknown>> {
  const request = getRequestSignal(signal);

  try {
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      return providerFailure(operation, response.status);
    }

    try {
      return { ok: true, output: await response.json() };
    } catch {
      return invalidProviderResponse(operation);
    }
  } catch {
    return providerFailure(operation);
  } finally {
    request.cancel();
  }
}

export function createSerperSearchProvider(
  options: SerperSearchProviderOptions,
): SearchProvider {
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    async search(query, signal) {
      const response = await requestJson(
        SEARCH_ENDPOINT,
        "search",
        options.apiKey,
        { q: query, num: MAX_SEARCH_RESULTS },
        fetchImplementation,
        signal,
      );

      return response.ok
        ? normalizeSearchResponse(query, options.apiKey, response.output)
        : response;
    },
    async fetch(url, signal) {
      const response = await requestJson(
        FETCH_ENDPOINT,
        "fetch",
        options.apiKey,
        { url },
        fetchImplementation,
        signal,
      );

      return response.ok
        ? normalizeFetchResponse(url, options.apiKey, response.output)
        : response;
    },
  };
}
