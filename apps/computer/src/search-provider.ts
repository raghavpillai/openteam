/** Provider APIs verified against their official documentation; see docs/web-search.md. */
import { SEARCH_PROVIDERS, type SearchProvider } from "@openteam/contracts/web-search";
export { SEARCH_PROVIDERS, type SearchProvider } from "@openteam/contracts/web-search";
export interface SearchConfiguration {
  provider?: SearchProvider;
  apiKey?: string;
}
export type SearchFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function requestFor(
  provider: SearchProvider,
  key: string,
  query: string
): { url: string; init: RequestInit } {
  const json = (url: string, auth: Record<string, string>, body: unknown) => ({
    url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify(body),
    },
  });
  switch (provider) {
    case "exa":
      return json(
        "https://api.exa.ai/search",
        { "x-api-key": key },
        { query, type: "auto", numResults: 10, contents: { highlights: true } }
      );
    case "tavily":
      return json(
        "https://api.tavily.com/search",
        { authorization: `Bearer ${key}` },
        {
          query,
          search_depth: "basic",
          max_results: 10,
          include_answer: false,
          include_raw_content: false,
        }
      );
    case "brave": {
      if (query.length > 600 || query.split(/\s+/).length > 75)
        throw new Error(
          "Brave Search requires at most 600 characters and 75 words. Shorten search_term."
        );
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.search = new URLSearchParams({
        q: query,
        count: "10",
        text_decorations: "false",
      }).toString();
      return {
        url: url.href,
        init: { headers: { accept: "application/json", "x-subscription-token": key } },
      };
    }
    case "bing-serpapi": {
      const url = new URL("https://serpapi.com/search.json");
      url.search = new URLSearchParams({ engine: "bing", q: query, api_key: key }).toString();
      return { url: url.href, init: { headers: { accept: "application/json" } } };
    }
  }
}

export async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Search provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 5 * 1024 * 1024) throw new Error("Search response exceeds 5 MiB");
      chunks.push(value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function resultsFor(provider: SearchProvider, body: Record<string, unknown>): SearchResult[] {
  if (
    body.error ||
    body.errors ||
    body.success === false ||
    object(body.search_metadata).status === "Error"
  )
    throw new Error("Search provider rejected the request");
  const rows =
    provider === "brave"
      ? object(body.web).results
      : provider === "bing-serpapi"
        ? body.organic_results
        : body.results;
  // Both APIs may omit their organic section on a successful zero-result search.
  if (
    rows === undefined &&
    ((provider === "brave" && object(body.query).original) ||
      (provider === "bing-serpapi" && object(body.search_metadata).status === "Success"))
  )
    return [];
  if (!Array.isArray(rows)) throw new Error("Search provider returned an invalid result list");
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 100)) {
    const value = object(row);
    const link = provider === "bing-serpapi" ? value.link : value.url;
    if (typeof link !== "string" || link.length > 8_000) continue;
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      seen.has(url.href)
    )
      continue;
    const snippet =
      provider === "exa"
        ? Array.isArray(value.highlights)
          ? value.highlights.filter((part) => typeof part === "string").join("\n")
          : value.text
        : provider === "tavily"
          ? value.content
          : provider === "brave"
            ? value.description
            : value.snippet;
    results.push({
      title: typeof value.title === "string" ? value.title.slice(0, 500) : url.hostname,
      url: url.href,
      description: typeof snippet === "string" ? snippet.slice(0, 2_000) : "",
    });
    seen.add(url.href);
    if (results.length === 10) break;
  }
  if (rows.length && !results.length)
    throw new Error("Search provider returned no usable result URLs");
  return results;
}

export class SearchProviderClient {
  constructor(
    private readonly configuration: (
      signal?: AbortSignal
    ) => SearchConfiguration | Promise<SearchConfiguration> = () => ({}),
    private readonly request: SearchFetch = fetch
  ) {}

  async search(searchTerm: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (typeof searchTerm !== "string" || !searchTerm.trim() || searchTerm.length > 16_000)
      throw new Error("search_term must be a nonempty string of at most 16000 characters");
    const { provider, apiKey } = await this.configuration(signal);
    signal?.throwIfAborted();
    if (!provider || !apiKey) {
      const text = provider
        ? `WebSearch is not configured: ${SEARCH_PROVIDERS[provider]} is selected but an API key is missing. Add it in Settings → Server → Web search.`
        : "WebSearch is not configured. Choose Exa, Tavily, Brave Search, or Bing via SerpApi and save an API key in Settings → Server → Web search.";
      return {
        content: [
          {
            type: "text" as const,
            text: `${text} Configure the key privately; never ask the user to paste it into chat. No search was performed. WebFetch can read known public URLs; its built-in provider needs no key.`,
          },
        ],
        details: { configured: false, provider: provider ?? null, results: [] as SearchResult[] },
      };
    }
    const query = searchTerm.trim();
    const { url, init } = requestFor(provider, apiKey, query);
    const timeout = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.request(url, { ...init, redirect: "error", signal: requestSignal });
    } catch {
      // SerpApi authenticates in the URL; never echo fetch errors or request URLs.
      signal?.throwIfAborted();
      throw new Error(
        `${SEARCH_PROVIDERS[provider]} search ${timeout.aborted ? "timed out" : "could not connect"}. Check the provider configuration and retry.`
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `${SEARCH_PROVIDERS[provider]} search failed (HTTP ${response.status}). ${[401, 403].includes(response.status) ? "Check the configured API key and its access." : [402, 429, 432, 433].includes(response.status) ? "Check the provider quota, balance, or rate limit." : "Retry later or check the provider configuration."}`
      );
    }
    let results: SearchResult[];
    try {
      results = resultsFor(provider, await boundedJson(response));
    } catch {
      signal?.throwIfAborted();
      throw new Error(
        `${SEARCH_PROVIDERS[provider]} returned an invalid or unsuccessful search response.`
      );
    }
    const redact = (value: string) => value.split(apiKey).join("[redacted]");
    results = results.map((result) => ({
      title: redact(result.title),
      url: redact(result.url),
      description: redact(result.description),
    }));
    return {
      content: [
        {
          type: "text" as const,
          text: results.map(result => `Title: ${result.title}${result.url ? `\nURL: ${result.url}` : ""}\nContent: ${result.description}\n---\n`).join("\n"),
        },
      ],
      details: { configured: true, provider, query, results },
    };
  }
}
