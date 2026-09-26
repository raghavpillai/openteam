/** Search provider APIs, verified against each provider's official documentation (2026-09). */
import { SEARCH_PROVIDERS, type SearchProvider, webProviderInfo } from "@openteam/contracts/web-search";
export { SEARCH_PROVIDERS, type SearchProvider } from "@openteam/contracts/web-search";
export interface SearchConfiguration {
  provider?: SearchProvider | null;
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
const string = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((part) => typeof part === "string") : []);

interface Row {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  published?: unknown;
}
interface Adapter {
  request(query: string, apiKey: string | undefined): { url: string; init: RequestInit };
  /** Result rows; an empty array means no results. Throw for a malformed body. */
  rows(body: Record<string, unknown>): Row[];
  /** Some providers reject a bad key with a status other than 401/403. */
  badKey?(status: number, body: Record<string, unknown>): boolean;
  /** Extra checks before sending, such as query length limits. */
  validate?(query: string): void;
}

const json = (url: string, headers: Record<string, string>, body: unknown) => ({
  url,
  init: { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
});
const bearer = (apiKey?: string): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {});
const list = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error("Search provider returned an invalid result list");
  return value.map(object);
};
const errorCode = (body: Record<string, unknown>) => string(object(body.error).code) || string(body.code);

const ADAPTERS: Record<SearchProvider, Adapter> = {
  exa: {
    request: (query, apiKey) =>
      json("https://api.exa.ai/search", { "x-api-key": apiKey ?? "" }, { query, type: "auto", numResults: 10, contents: { highlights: { maxCharacters: 500 } } }),
    rows: (body) =>
      list(body.results).map((row) => ({
        title: row.title,
        url: row.url,
        snippet: strings(row.highlights).join("\n") || row.text,
        published: row.publishedDate,
      })),
  },
  brave: {
    validate: (query) => {
      if (query.length > 600 || query.split(/\s+/).length > 75)
        throw new Error("Brave Search requires at most 600 characters and 75 words. Shorten search_term.");
    },
    request: (query, apiKey) => {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.search = new URLSearchParams({ q: query, count: "10", text_decorations: "false" }).toString();
      return { url: url.href, init: { headers: { accept: "application/json", "x-subscription-token": apiKey ?? "" } } };
    },
    // Brave omits its web section on a successful search with no results.
    rows: (body) =>
      body.web === undefined && object(body.query).original !== undefined
        ? []
        : list(object(body.web).results).map((row) => ({ title: row.title, url: row.url, snippet: row.description, published: row.page_age })),
    badKey: (status, body) => status === 422 && ["SUBSCRIPTION_TOKEN_INVALID", "VALIDATION"].includes(errorCode(body)),
  },
  firecrawl: {
    validate: (query) => {
      if (query.length > 500) throw new Error("Firecrawl search accepts at most 500 characters. Shorten search_term.");
    },
    // Highlights are free and put the answer in more snippets (14 vs 12 of 15 benchmark queries);
    // normalize() still cuts each snippet to 2,000 characters.
    request: (query, apiKey) => json("https://api.firecrawl.dev/v2/search", bearer(apiKey), { query, limit: 10, highlights: true }),
    rows: (body) => {
      if (body.success === false) throw new Error("Firecrawl rejected the search");
      const web = object(body.data).web;
      return web === undefined ? [] : list(web).map((row) => ({ title: row.title, url: row.url, snippet: row.description }));
    },
  },
  parallel: {
    request: (query, apiKey) =>
      json("https://api.parallel.ai/v1/search", { "x-api-key": apiKey ?? "" }, {
        objective: query.slice(0, 5_000),
        search_queries: [query.slice(0, 200)],
        mode: "fast",
        advanced_settings: { max_results: 10, excerpt_settings: { max_chars_per_result: 1_000 } },
      }),
    rows: (body) =>
      list(body.results).map((row) => ({ title: row.title, url: row.url, snippet: strings(row.excerpts).join("\n"), published: row.publish_date })),
  },
  perplexity: {
    request: (query, apiKey) =>
      json("https://api.perplexity.ai/search", bearer(apiKey), { query, max_results: 10, search_type: "fast", search_context_size: "low" }),
    rows: (body) => list(body.results).map((row) => ({ title: row.title, url: row.url, snippet: row.snippet, published: row.date })),
  },
  "bing-serpapi": {
    request: (query, apiKey) => {
      const url = new URL("https://serpapi.com/search.json");
      url.search = new URLSearchParams({ engine: "bing", q: query, api_key: apiKey ?? "" }).toString();
      return { url: url.href, init: { headers: { accept: "application/json" } } };
    },
    rows: (body) => {
      // SerpApi reports "no results" as a 200 with an error message.
      if (/hasn't returned any results/i.test(string(body.error))) return [];
      if (body.error || object(body.search_metadata).status === "Error") throw new Error("SerpApi rejected the search");
      return body.organic_results === undefined && object(body.search_metadata).status === "Success"
        ? []
        : list(body.organic_results).map((row) => ({ title: row.title, url: row.link, snippet: row.snippet, published: row.date }));
    },
  },
};

/** A provider-reported failure whose message is safe to show. */
class SearchProviderError extends Error {}

export class ResponseTooLargeError extends Error {}

export async function boundedJson(response: Response, limit = 5 * 1024 * 1024): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Search provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new ResponseTooLargeError(`Provider response exceeds ${limit / 1024 / 1024} MiB`);
      chunks.push(value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function normalize(rows: Row[]): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 100)) {
    const link = row.url;
    if (typeof link !== "string" || link.length > 8_000) continue;
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
    const published = string(row.published).slice(0, 10);
    const snippet = string(row.snippet).replace(/\s+\n/g, "\n").trim();
    results.push({
      title: (string(row.title).trim() || url.hostname).slice(0, 500),
      url: url.href,
      description: `${/^\d{4}-\d{2}-\d{2}$/.test(published) ? `Published ${published}. ` : ""}${snippet}`.slice(0, 2_000),
    });
    seen.add(url.href);
    if (results.length === 10) break;
  }
  if (rows.length && !results.length) throw new SearchProviderError("The provider returned no usable result URLs.");
  return results;
}

/** Provider error bodies, when they explain a failure without echoing the request. */
function providerMessage(body: Record<string, unknown>): string {
  const error = body.error;
  return (
    string(object(error).message) ||
    string(object(error).detail) ||
    string(error) ||
    string(object(body.detail).error) ||
    string(body.detail) ||
    string(body.message)
  )
    .replace(/\s+/g, " ")
    .slice(0, 200)
    .replace(/[.\s]+$/, "");
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
    const query = searchTerm.trim();
    if (!provider || !webProviderInfo("search", provider) || !apiKey)
      throw new Error(
        provider
          ? `Web search is not configured: ${SEARCH_PROVIDERS[provider] ?? provider} is selected but its API key is missing. No search was performed. Tell the user they can finish setting it up or choose another search provider in Settings → Providers. Never ask for API keys in chat.`
          : "Web search is not configured: the user has not chosen a search provider in Settings → Providers. No search was performed. Tell the user web search isn't set up and that they can choose a provider there. Never ask for API keys in chat. You can still read known URLs with WebFetch or the browser."
      );
    const name = SEARCH_PROVIDERS[provider];
    const adapter = ADAPTERS[provider];
    adapter.validate?.(query);
    const { url, init } = adapter.request(query, apiKey);
    const timeout = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const redact = (value: string) => (apiKey ? value.split(apiKey).join("[redacted]") : value);
    let response: Response;
    try {
      response = await this.request(url, { ...init, redirect: "error", signal: requestSignal });
    } catch {
      // SerpApi authenticates in the URL; never echo fetch errors or request URLs.
      signal?.throwIfAborted();
      throw new Error(`${name} search ${timeout.aborted ? "timed out" : "could not connect"}. Check the provider configuration and retry.`);
    }
    let rows: Row[];
    try {
      const body = await boundedJson(response).catch(() => ({}) as Record<string, unknown>);
      signal?.throwIfAborted();
      if (!response.ok) {
        const status = response.status;
        const detail = redact(providerMessage(body));
        const hint =
          status === 401 || status === 403 || adapter.badKey?.(status, body)
            ? "Check the configured API key and its access in Settings → Providers."
            : [402, 429, 432, 433].includes(status)
              ? "Check the provider quota, balance, or rate limit."
              : "Retry later or check the provider configuration.";
        throw new SearchProviderError(`${name} search failed (HTTP ${status})${detail ? `: ${detail}` : ""}. ${hint}`);
      }
      rows = adapter.rows(body);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SearchProviderError) throw new Error(redact(error.message));
      throw new Error(`${name} returned an invalid or unsuccessful search response.`);
    }
    let results: SearchResult[];
    try {
      results = normalize(rows);
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
    results = results.map((result) => ({ title: redact(result.title), url: redact(result.url), description: redact(result.description) }));
    return this.format(provider, query, results);
  }

  private format(provider: SearchProvider, query: string, results: SearchResult[]) {
    return {
      content: [
        {
          type: "text" as const,
          text: results.length
            ? results
                .map(
                  (result) =>
                    `Title: ${result.title}${result.url ? `\nURL: ${result.url}` : ""}\nContent: ${result.description}\n---\n`
                )
                .join("\n")
            : `${SEARCH_PROVIDERS[provider]} found no results for this query.`,
        },
      ],
      details: { configured: true, provider, query, results },
    };
  }
}
