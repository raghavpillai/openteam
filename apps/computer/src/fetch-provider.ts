/** Fetch provider APIs, verified against each provider's official documentation (2026-09). */
import {
  DEFAULT_FETCH_PROVIDER,
  FETCH_PROVIDERS,
  type FetchProvider,
  webProviderInfo,
} from "@openteam/contracts/web-search";
import { boundedJson, type SearchFetch } from "./search-provider";
import { publicWebUrl, validatePublicWebUrl } from "./public-web-url";

export interface FetchConfiguration {
  /** Omitted: the built-in fetcher. null: fetch is turned off. */
  provider?: FetchProvider | null;
  apiKey?: string;
}
type FetchResult =
  | { configured: false; provider: FetchProvider | null; message: string }
  | { configured: true; provider: "builtin" }
  | { configured: true; provider: Exclude<FetchProvider, "builtin">; url: string; text: string; note?: string };

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** A provider-reported failure whose message is safe to show (no request data). */
class ProviderPageError extends Error {}

interface Adapter {
  request(url: string, apiKey: string | undefined): { endpoint: string; init: RequestInit };
  parse(body: Record<string, unknown>): { url?: unknown; text: unknown; title?: unknown; note?: string };
  /** An error response that means the provider declines this site, not a key or quota problem. */
  refusesSite?(status: number, detail: string): boolean;
}

/** Firecrawl bills one credit per PDF page (RFC 9110 alone would cost 194). */
export const FIRECRAWL_PDF_PAGES = 25;

const post = (endpoint: string, headers: Record<string, string>, body: unknown) => ({
  endpoint,
  init: { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
});
const bearer = (apiKey?: string): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {});
const targetFailed = (status: unknown) => {
  if (typeof status === "number" && status >= 400) throw new ProviderPageError(`The site returned HTTP ${status}.`);
};

const ADAPTERS: Record<Exclude<FetchProvider, "builtin">, Adapter> = {
  firecrawl: {
    request: (url, apiKey) =>
      post("https://api.firecrawl.dev/v2/scrape", bearer(apiKey), {
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 0,
        timeout: 45_000,
        parsers: [{ type: "pdf", maxPages: FIRECRAWL_PDF_PAGES }],
      }),
    parse: (body) => {
      if (body.success === false) throw new ProviderPageError(text(body.error) || "Firecrawl could not scrape the page.");
      const data = record(body.data);
      const metadata = record(data.metadata);
      targetFailed(metadata.statusCode);
      const read = Number(metadata.numPages);
      const total = Number(metadata.totalPages);
      return {
        url: metadata.url ?? metadata.sourceURL,
        text: data.markdown,
        title: metadata.title,
        note:
          total > read
            ? `Firecrawl read only the first ${read} of ${total} PDF pages. Download the PDF with Shell and use Read for the rest.`
            : undefined,
      };
    },
    // Sites Firecrawl declines by policy (NYT, Reddit, LinkedIn, Yelp, ...) return HTTP 403.
    refusesSite: (status, detail) => status === 403 && /do not support this site/i.test(detail),
  },
  exa: {
    // Crawls live unless Exa fetched the page within the hour, and serves Exa's cached copy when
    // the crawl fails. With 0 there is no cached copy to serve (benchmark: 66% vs 61% useful).
    request: (url, apiKey) =>
      post("https://api.exa.ai/contents", { "x-api-key": apiKey ?? "" }, { urls: [url], text: true, maxAgeHours: 1, livecrawlTimeout: 15_000 }),
    parse: (body) => {
      const failed = (Array.isArray(body.statuses) ? body.statuses : []).map(record).find((status) => status.status !== "success");
      if (failed) {
        const error = record(failed.error);
        throw new ProviderPageError(`Exa could not read the page (${text(error.tag) || "error"}${error.httpStatusCode ? `, HTTP ${error.httpStatusCode}` : ""}).`);
      }
      const result = record(Array.isArray(body.results) && body.results.length === 1 ? body.results[0] : null);
      return { url: result.url, text: result.text, title: result.title };
    },
  },
  parallel: {
    request: (url, apiKey) =>
      post("https://api.parallel.ai/v1/extract", { "x-api-key": apiKey ?? "" }, {
        urls: [url],
        advanced_settings: { full_content: true, fetch_policy: { max_age_seconds: 600, timeout_seconds: 30 } },
      }),
    parse: (body) => {
      const failed = (Array.isArray(body.errors) ? body.errors : []).map(record)[0];
      if (failed) throw new ProviderPageError(`Parallel could not read the page (${text(failed.error_type) || "error"}${failed.http_status_code ? `, HTTP ${failed.http_status_code}` : ""}).`);
      const result = record(Array.isArray(body.results) && body.results.length === 1 ? body.results[0] : null);
      const excerpts = Array.isArray(result.excerpts) ? result.excerpts.filter((part) => typeof part === "string").join("\n\n") : "";
      return { url: result.url, text: text(result.full_content) || excerpts, title: result.title };
    },
  },
};

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 5 * 1024 * 1024) throw new Error("Response exceeds 5 MiB");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Provider error bodies, when they explain a request-level failure without echoing it. */
async function providerMessage(response: Response): Promise<string> {
  try {
    const body = record(JSON.parse((await boundedText(response)).slice(0, 20_000)));
    const error = body.error;
    const message = text(record(error).message) || text(error) || text(record(body.detail).error) || text(body.message) || text(record(Array.isArray(body.errors) ? body.errors[0] : null).message);
    return message.replace(/\s+/g, " ").slice(0, 200).replace(/[.\s]+$/, "");
  } catch {
    return "";
  }
}

export class FetchProviderClient {
  constructor(
    private readonly configuration: (
      signal?: AbortSignal
    ) => FetchConfiguration | Promise<FetchConfiguration> = () => ({}),
    private readonly request: SearchFetch = fetch,
    private readonly validate = validatePublicWebUrl
  ) {}
  async fetch(value: string, signal?: AbortSignal): Promise<FetchResult> {
    signal?.throwIfAborted();
    if (typeof value !== "string" || value.length > 8000)
      throw new Error("WebFetch requires a URL of at most 8000 characters");
    publicWebUrl(value);
    const configured = await this.configuration(signal);
    const provider = configured.provider === undefined ? DEFAULT_FETCH_PROVIDER : configured.provider;
    const { apiKey } = configured;
    signal?.throwIfAborted();
    if (provider === "builtin") return { configured: true, provider };
    if (!provider || !webProviderInfo("fetch", provider) || !apiKey)
      return {
        configured: false,
        provider,
        message: provider
          ? `Web fetch is not configured: ${FETCH_PROVIDERS[provider] ?? provider} is selected but its API key is missing. No page was fetched. Tell the user they can finish setting it up or choose the built-in fetcher in Settings → Providers. Never ask for API keys in chat.`
          : "Web fetch is turned off: the user turned off page fetching in Settings → Providers. No page was fetched. Tell the user fetch is off and that they can turn it on there; you can still open pages with the browser tool.",
      };
    const name = FETCH_PROVIDERS[provider];
    const adapter = ADAPTERS[provider];
    const url = (await this.validate(value, signal)).href;
    const { endpoint, init } = adapter.request(url, apiKey);
    const timeout = AbortSignal.timeout(60_000);
    let response: Response;
    try {
      response = await this.request(endpoint, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch {
      signal?.throwIfAborted();
      // Some providers authenticate in the URL; never echo fetch errors or request URLs.
      throw new Error(`${name} ${timeout.aborted ? "timed out" : "could not be reached"}. Retry later, or open the page with the browser tool.`);
    }
    if (!response.ok) {
      const detail = await providerMessage(response);
      const status = response.status;
      if (adapter.refusesSite?.(status, detail))
        throw new Error(`${name} doesn't fetch this site. Open the page with the browser tool instead.`);
      const reason =
        status === 401 || status === 403
          ? "Check the API key and its access in Settings → Providers."
          : [402, 429, 432, 433].includes(status)
            ? "Check the provider's quota, balance or rate limit."
            : status === 400 || status === 408 || status === 422
              ? "The provider couldn't read this page; try the browser tool."
              : "Retry later, or open the page with the browser tool.";
      const safe = apiKey ? detail.split(apiKey).join("[redacted]") : detail;
      throw new Error(`${name} fetch failed (HTTP ${status})${safe ? `: ${safe}` : ""}. ${reason}`);
    }
    try {
      const body = await boundedJson(response);
      signal?.throwIfAborted();
      const parsed = adapter.parse(body);
      let content = text(parsed.text);
      if (!content.trim()) throw new ProviderPageError(`${name} returned no page content.`);
      // Main-content extraction often drops the page title; lead with it like the built-in reader.
      const title = (Array.isArray(parsed.title) ? text(parsed.title[0]) : text(parsed.title)).replace(/\s+/g, " ").trim().slice(0, 300);
      if (title && !content.slice(0, 500).includes(title)) content = `# ${title}\n\n${content}`;
      const redact = (s: string) => s.split(apiKey).join("[redacted]");
      let resultUrl = url;
      try {
        if (typeof parsed.url === "string" && parsed.url) resultUrl = publicWebUrl(parsed.url).href;
      } catch {
        throw new ProviderPageError(`${name} returned an unusable page URL.`);
      }
      return { configured: true, provider, url: redact(resultUrl), text: redact(content), ...(parsed.note ? { note: parsed.note } : {}) };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ProviderPageError) {
        const message = apiKey ? error.message.split(apiKey).join("[redacted]") : error.message;
        throw new Error(`${message} Try another URL, or open the page with the browser tool.`);
      }
      throw new Error(`${name} returned an invalid response. Try another URL, or open the page with the browser tool.`);
    }
  }
}
