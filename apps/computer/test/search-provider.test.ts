import { expect, test } from "bun:test";
import {
  SEARCH_PROVIDERS,
  SearchProviderClient,
  type SearchProvider,
  type SearchFetch,
} from "../src/search-provider";

const key = "synthetic-search-key";
const fixture = (provider: SearchProvider) => {
  const hit = { title: "Reference", url: "https://example.com/reference" };
  return provider === "exa"
    ? { results: [{ ...hit, highlights: ["An extract."] }] }
    : provider === "tavily"
      ? { results: [{ ...hit, content: "An extract." }] }
      : provider === "brave"
        ? { web: { results: [{ ...hit, description: "An extract." }] } }
        : {
            search_metadata: { status: "Success" },
            organic_results: [{ title: hit.title, link: hit.url, snippet: "An extract." }],
          };
};

test("unset search stays usable for setup guidance without any network request or implicit fallback", async () => {
  for (const configuration of [{}, { provider: "exa" as const }]) {
    const client = new SearchProviderClient(() => configuration, (async () => {
      throw new Error("must not call network");
    }) as SearchFetch);
    const result = await client.search("reference");
    expect(result.details.configured).toBe(false);
    expect(result.content[0]!.text).toContain("No search was performed");
    expect(result.content[0]!.text).toContain("Settings → Server → Web search");
  }

});

for (const provider of Object.keys(SEARCH_PROVIDERS) as SearchProvider[]) {
  test(`${provider} uses its documented endpoint/auth/body and normalizes citations`, async () => {
    let requests = 0;
    const client = new SearchProviderClient(() => ({ provider, apiKey: key }), (async (
      input,
      init
    ) => {
      requests++;
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (provider === "exa") {
        expect(url.href).toBe("https://api.exa.ai/search");
        expect(headers.get("x-api-key")).toBe(key);
        expect(JSON.parse(String(init?.body))).toEqual({
          query: "reference & example",
          type: "auto",
          numResults: 10,
          contents: { highlights: true },
        });
      } else if (provider === "tavily") {
        expect(url.href).toBe("https://api.tavily.com/search");
        expect(headers.get("authorization")).toBe(`Bearer ${key}`);
        expect(JSON.parse(String(init?.body))).toEqual({
          query: "reference & example",
          search_depth: "basic",
          max_results: 10,
          include_answer: false,
          include_raw_content: false,
        });
      } else if (provider === "brave") {
        expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
        expect(headers.get("x-subscription-token")).toBe(key);
        expect(url.searchParams.get("q")).toBe("reference & example");
        expect(url.searchParams.get("text_decorations")).toBe("false");
      } else {
        expect(url.origin + url.pathname).toBe("https://serpapi.com/search.json");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          engine: "bing",
          q: "reference & example",
          api_key: key,
        });
      }
      return Response.json(fixture(provider));
    }) as SearchFetch);
    const result = await client.search(" reference & example ");
    expect(requests).toBe(1);
    expect(result.details).toMatchObject({
      configured: true,
      provider,
      results: [
        { title: "Reference", url: "https://example.com/reference", description: "An extract." },
      ],
    });
    expect(result.content[0]!.text).toContain("[Reference](https://example.com/reference)");
    expect(JSON.stringify(result)).not.toContain(key);
  });
}

test("provider errors, malformed and oversized responses never leak credentials or request URLs", async () => {
  const responses = [
    () => new Response(key, { status: 401 }),
    () => Response.json({ error: key }),
    () => new Response(key),
    () => Response.json({}),
    () => new Response('"' + "x".repeat(5 * 1024 * 1024) + '"'),
  ];
  for (const respond of responses) {
    const client = new SearchProviderClient(
      () => ({ provider: "bing-serpapi", apiKey: key }),
      (async () => respond()) as SearchFetch
    );
    const error = await client.search("reference").then(
      () => null,
      (error: Error) => error
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain(key);
    expect(error!.message).not.toContain("api_key");
  }
  const client = new SearchProviderClient(
    () => ({ provider: "bing-serpapi", apiKey: key }),
    (async (url) => {
      throw new Error(String(url));
    }) as SearchFetch
  );
  await expect(client.search("reference")).rejects.toThrow(
    "Bing via SerpApi search could not connect"
  );
});

test("search distinguishes empty results, rejects unusable URLs, deduplicates and bounds results", async () => {
  for (const provider of Object.keys(SEARCH_PROVIDERS) as SearchProvider[]) {
    const body =
      provider === "brave"
        ? { query: { original: "nothing" } }
        : provider === "bing-serpapi"
          ? { search_metadata: { status: "Success" } }
          : { results: [] };
    const client = new SearchProviderClient(() => ({ provider, apiKey: key }), (async () =>
      Response.json(body)) as SearchFetch);
    expect((await client.search("nothing")).content[0]!.text).toBe("No search results found.");
  }
  const results = [
    { url: "javascript:alert(1)" },
    { url: "https://secret@example.com/" },
    { url: "https://example.com/first", title: "[link]", highlights: ["x".repeat(3000)] },
    { url: "https://example.com/first" },
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}` })),
  ];
  const client = new SearchProviderClient(() => ({ provider: "exa", apiKey: key }), (async () =>
    Response.json({ results })) as SearchFetch);
  const result = await client.search("reference");
  expect(result.details.results).toHaveLength(10);
  expect(result.details.results[0]?.description.length).toBe(2000);
  expect(result.content[0]!.text).toContain("\\[link\\]");
});

test("Brave query limits and cancellation stop before sending a request", async () => {
  let requests = 0;
  const client = new SearchProviderClient(() => ({ provider: "brave", apiKey: key }), (async () => {
    requests++;
    return Response.json(fixture("brave"));
  }) as SearchFetch);
  await expect(client.search("x".repeat(601))).rejects.toThrow("600 characters");
  await expect(client.search("x ".repeat(76))).rejects.toThrow("75 words");
  await expect(client.search("valid", AbortSignal.abort())).rejects.toThrow();
  expect(requests).toBe(0);
});

test("an in-flight request receives cancellation and is never retried on another provider", async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = new SearchProviderClient(() => ({ provider: "exa", apiKey: key }), (async (
    _url,
    init
  ) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      controller.abort();
    });
  }) as SearchFetch);
  await expect(client.search("reference", controller.signal)).rejects.toThrow();
  expect(requests).toBe(1);
});
