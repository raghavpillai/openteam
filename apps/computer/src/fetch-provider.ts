import { FETCH_PROVIDERS, type FetchProvider } from "@openteam/contracts/web-search";
import { boundedJson, type SearchFetch } from "./search-provider";
import { publicWebUrl, validatePublicWebUrl } from "./public-web-url";
export interface FetchConfiguration {
  provider: FetchProvider;
  apiKey?: string;
}
type FetchResult =
  | { configured: false; provider: FetchProvider; message: string }
  | { configured: true; provider: "builtin" }
  | { configured: true; provider: "exa" | "tavily"; url: string; text: string };
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export class FetchProviderClient {
  constructor(
    private readonly configuration: (
      signal?: AbortSignal
    ) => FetchConfiguration | Promise<FetchConfiguration> = () => ({ provider: "builtin" }),
    private readonly request: SearchFetch = fetch,
    private readonly validate = validatePublicWebUrl
  ) {}
  async fetch(value: string, signal?: AbortSignal): Promise<FetchResult> {
    signal?.throwIfAborted();
    if (typeof value !== "string" || value.length > 8000)
      throw new Error("WebFetch requires a URL of at most 8000 characters");
    publicWebUrl(value);
    const { provider, apiKey } = await this.configuration(signal);
    signal?.throwIfAborted();
    if (provider === "builtin") return { configured: true, provider };
    if (!apiKey)
      return {
        configured: false,
        provider,
        message: `WebFetch is not configured: ${FETCH_PROVIDERS[provider]} needs an API key in Settings → Server → Web fetch. No page was fetched. Select built-in HTTP fetch to read public pages without a key. Never paste API keys into chat.`,
      };
    const url = (await this.validate(value, signal)).href;
    const isExa = provider === "exa";
    const timeout = AbortSignal.timeout(30_000);
    let response: Response;
    try {
      response = await this.request(
        isExa ? "https://api.exa.ai/contents" : "https://api.tavily.com/extract",
        {
          method: "POST",
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            "content-type": "application/json",
            ...(isExa ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` }),
          },
          body: JSON.stringify(
            isExa
              ? { ids: [url], text: true, maxAgeHours: 0, livecrawlTimeout: 15000 }
              : {
                  urls: [url],
                  extract_depth: "advanced",
                  format: "markdown",
                  include_images: false,
                  timeout: 20,
                }
          ),
        }
      );
    } catch {
      signal?.throwIfAborted();
      throw new Error(
        `${FETCH_PROVIDERS[provider]} ${timeout.aborted ? "timed out" : "could not connect"}. Check the provider configuration and retry.`
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `${FETCH_PROVIDERS[provider]} fetch failed (HTTP ${response.status}). ${[401, 403].includes(response.status) ? "Check the API key and access." : [402, 429, 432, 433].includes(response.status) ? "Check quota, balance, or rate limit." : "Retry later or check the provider configuration."}`
      );
    }
    try {
      const body = await boundedJson(response);
      signal?.throwIfAborted();
      if (body.error || body.errors || body.detail || body.success === false)
        throw new Error("Provider error");
      if (!Array.isArray(body.results) || body.results.length !== 1)
        throw new Error("No single document result");
      if (
        isExa &&
        Array.isArray(body.statuses) &&
        body.statuses.some((s) => record(s).status !== "success")
      )
        throw new Error("URL crawl failed");
      if (!isExa && Array.isArray(body.failed_results) && body.failed_results.length)
        throw new Error("URL extraction failed");
      const result = record(body.results[0]);
      const text = isExa ? result.text : result.raw_content;
      if (typeof text !== "string" || !text.trim() || typeof result.url !== "string")
        throw new Error("Missing page content");
      const resultUrl = publicWebUrl(result.url).href;
      const redact = (s: string) =>
        s.split(apiKey).join("[redacted]").split(encodeURIComponent(apiKey)).join("[redacted]");
      return { configured: true, provider, url: redact(resultUrl), text: redact(text) };
    } catch {
      signal?.throwIfAborted();
      throw new Error(
        `${FETCH_PROVIDERS[provider]} could not extract this page or returned an invalid response. Try another public URL or choose built-in HTTP fetch.`
      );
    }
  }
}
