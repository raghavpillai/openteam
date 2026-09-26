import { expect, test } from "bun:test";
import {
  SEARCH_PROVIDERS,
  SearchProviderClient,
  type SearchProvider,
  type SearchFetch,
} from "../src/search-provider";

const key = "synthetic-search-key";
test("unconfigured search fails clearly without any network request or implicit fallback", async () => {
  for (const [configuration, expected] of [
    [{}, "the user has not chosen a search provider in Settings → Providers"],
    [{ provider: null }, "the user has not chosen a search provider in Settings → Providers"],
    [{ provider: "exa" as const }, "Exa is selected but its API key is missing"],
  ] as const) {
    const client = new SearchProviderClient(() => configuration, (async () => {
      throw new Error("must not call network");
    }) as SearchFetch);
    const error = await client.search("reference").then(() => null, (error: Error) => error);
    expect(error?.message).toContain("Web search is not configured");
    expect(error?.message).toContain(expected);
    expect(error?.message).toContain("No search was performed");
  }
});

type Spec = {
  method: "GET" | "POST";
  url: string;
  auth: [string, string] | "query";
  body?: unknown;
  query?: Record<string, string>;
  success: unknown;
  empty?: () => Response;
};
const hit = { title: "Reference", url: "https://example.com/reference" };
// Request and response shapes follow each provider's documented examples (2026-09).
const SPECS: Record<SearchProvider, Spec> = {
  exa: {
    method: "POST",
    url: "https://api.exa.ai/search",
    auth: ["x-api-key", key],
    body: { query: "reference & example", type: "auto", numResults: 10, contents: { highlights: true } },
    success: { results: [{ ...hit, highlights: ["An extract."], publishedDate: "2026-09-01T00:00:00.000Z" }] },
    empty: () => Response.json({ results: [] }),
  },
  brave: {
    method: "GET",
    url: "https://api.search.brave.com/res/v1/web/search",
    auth: ["x-subscription-token", key],
    query: { q: "reference & example", count: "10", text_decorations: "false" },
    success: { query: { original: "reference & example" }, web: { results: [{ ...hit, description: "An extract.", page_age: "2026-09-01T00:00:00" }] } },
    empty: () => Response.json({ query: { original: "nothing" } }),
  },
  firecrawl: {
    method: "POST",
    url: "https://api.firecrawl.dev/v2/search",
    auth: ["authorization", `Bearer ${key}`],
    body: { query: "reference & example", limit: 10, highlights: true },
    success: { success: true, data: { web: [{ ...hit, description: "An extract.", position: 1 }] } },
    empty: () => Response.json({ success: true, data: {} }),
  },
  parallel: {
    method: "POST",
    url: "https://api.parallel.ai/v1/search",
    auth: ["x-api-key", key],
    body: {
      objective: "reference & example",
      search_queries: ["reference & example"],
      mode: "fast",
      advanced_settings: { max_results: 10, excerpt_settings: { max_chars_per_result: 1_000 } },
    },
    success: { search_id: "s", results: [{ ...hit, excerpts: ["An extract."], publish_date: "2026-09-01" }] },
    empty: () => Response.json({ search_id: "s", results: [] }),
  },
  perplexity: {
    method: "POST",
    url: "https://api.perplexity.ai/search",
    auth: ["authorization", `Bearer ${key}`],
    body: { query: "reference & example", max_results: 10, search_type: "fast", search_context_size: "low" },
    success: { results: [{ ...hit, snippet: "An extract.", date: "2026-09-01" }], id: "x" },
    empty: () => Response.json({ results: [], id: "x" }),
  },
  "bing-serpapi": {
    method: "GET",
    url: "https://serpapi.com/search.json",
    auth: "query",
    query: { engine: "bing", q: "reference & example", api_key: key },
    success: { search_metadata: { status: "Success" }, organic_results: [{ title: hit.title, link: hit.url, snippet: "An extract." }] },
    empty: () => Response.json({ search_metadata: { status: "Success" }, error: "Bing hasn't returned any results for this query." }),
  },
};

const searchClient = (provider: SearchProvider, respond: (url: URL, init: RequestInit) => Response, apiKey: string | null = key) =>
  new SearchProviderClient(() => ({ provider, apiKey: apiKey ?? undefined }), (async (input, init) =>
    respond(new URL(String(input)), init ?? {})) as SearchFetch);

for (const [provider, spec] of Object.entries(SPECS) as [SearchProvider, Spec][]) {
  test(`${provider} uses its documented endpoint/auth/body and normalizes citations`, async () => {
    let requests = 0;
    const result = await searchClient(provider, (url, init) => {
      requests++;
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.method ?? "GET").toBe(spec.method);
      expect(url.origin + url.pathname).toBe(spec.url);
      if (spec.auth !== "query") expect(new Headers(init.headers).get(spec.auth[0])).toBe(spec.auth[1]);
      if (spec.body !== undefined) expect(JSON.parse(String(init.body))).toEqual(spec.body);
      if (spec.query) expect(Object.fromEntries(url.searchParams)).toEqual(spec.query);
      return Response.json(spec.success);
    }).search(" reference & example ");
    expect(requests).toBe(1);
    expect(result.details).toMatchObject({ configured: true, provider });
    expect(result.details.results).toHaveLength(1);
    expect(result.details.results[0]).toMatchObject({ title: "Reference", url: "https://example.com/reference" });
    expect(result.details.results[0]!.description).toEndWith("An extract.");
    expect(result.content[0]!.text).toStartWith("Title: Reference\nURL: https://example.com/reference\nContent: ");
    expect(JSON.stringify(result)).not.toContain(key);
  });
  test(`${provider} treats its documented empty answer as no results`, async () => {
    const result = await searchClient(provider, () => spec.empty!()).search("nothing");
    expect(result.content[0]!.text).toBe(`${SEARCH_PROVIDERS[provider]} found no results for this query.`);
  });
}

test("dates from providers become a Published prefix", async () => {
  const result = await searchClient("perplexity", () => Response.json(SPECS.perplexity.success)).search("q");
  expect(result.details.results[0]!.description).toBe("Published 2026-09-01. An extract.");
});

test("bad keys map to key guidance whatever status the provider uses", async () => {
  for (const [provider, response] of [
    ["exa", Response.json({ error: `Invalid API key ${key}`, tag: "INVALID_API_KEY" }, { status: 401 })],
    ["brave", Response.json({ type: "ErrorResponse", error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: "The provided subscription token is invalid.", status: 422 } }, { status: 422 })],
    ["perplexity", Response.json({ error: { message: "Invalid API key", type: "invalid_api_key" } }, { status: 401 })],
    ["parallel", Response.json({ code: 16, message: "Invalid API key (C.1)" }, { status: 401 })],
  ] as const) {
    const error = await searchClient(provider, () => response).search("q").then(() => null, (e: Error) => e);
    expect(error?.message).toContain("Check the configured API key");
    expect(error?.message).not.toContain(key);
  }
  const quota = await searchClient("firecrawl", () => Response.json({ success: false, error: "Insufficient credits." }, { status: 402 })).search("q").then(() => null, (e: Error) => e);
  expect(quota?.message).toBe("Firecrawl search failed (HTTP 402): Insufficient credits. Check the provider quota, balance, or rate limit.");
});

test("every third-party search provider needs its key; nothing is sent without one", async () => {
  for (const provider of Object.keys(SPECS) as SearchProvider[]) {
    const error = await searchClient(provider, () => {
      throw new Error("must not call network");
    }, null).search("q").then(() => null, (e: Error) => e);
    expect(error?.message).toContain(`${SEARCH_PROVIDERS[provider]} is selected but its API key is missing`);
  }
});

test("provider errors, malformed and oversized responses never leak credentials or request URLs", async () => {
  const responses = [
    () => new Response(key, { status: 401 }),
    () => Response.json({ error: key }),
    () => new Response(key),
    () => Response.json({}),
    () => new Response('"' + "x".repeat(5 * 1024 * 1024) + '"'),
  ];
  for (const respond of responses) {
    const error = await searchClient("bing-serpapi", () => respond()).search("reference").then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain(key);
    expect(error!.message).not.toContain("api_key");
  }
  const failing = await searchClient("bing-serpapi", (url) => {
    throw new Error(url.href);
  }).search("reference").then(() => null, (e: Error) => e);
  expect(failing?.message).toBe("Bing search could not connect. Check the provider configuration and retry.");
});

test("search rejects unusable URLs, deduplicates and bounds results", async () => {
  const results = [
    { url: "javascript:alert(1)" },
    { url: "https://secret@example.com/" },
    { url: "https://example.com/first", title: "[link]", highlights: ["x".repeat(3000)] },
    { url: "https://example.com/first" },
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}` })),
  ];
  const result = await searchClient("exa", () => Response.json({ results })).search("reference");
  expect(result.details.results).toHaveLength(10);
  expect(result.details.results[0]?.description.length).toBe(2000);
  expect(result.content[0]!.text).toContain("Title: [link]");
  const unusable = await searchClient("exa", () => Response.json({ results: [{ url: "javascript:alert(1)" }] })).search("q").then(() => null, (e: Error) => e);
  expect(unusable?.message).toBe("Exa: The provider returned no usable result URLs.");
});

test("query limits and cancellation stop before sending a request", async () => {
  let requests = 0;
  const count = () => {
    requests++;
    return Response.json(SPECS.brave.success);
  };
  await expect(searchClient("brave", count).search("x".repeat(601))).rejects.toThrow("600 characters");
  await expect(searchClient("brave", count).search("x ".repeat(76))).rejects.toThrow("75 words");
  await expect(searchClient("firecrawl", count).search("x".repeat(501))).rejects.toThrow("500 characters");
  await expect(searchClient("brave", count).search("valid", AbortSignal.abort())).rejects.toThrow();
  expect(requests).toBe(0);
});

test("an in-flight request receives cancellation and is never retried on another provider", async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = new SearchProviderClient(() => ({ provider: "exa", apiKey: key }), (async (_url, init) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      controller.abort();
    });
  }) as SearchFetch);
  await expect(client.search("reference", controller.signal)).rejects.toThrow();
  expect(requests).toBe(1);
});
