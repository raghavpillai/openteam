import { expect, test } from "bun:test";
import { serverSearchConfiguration } from "../src/search-settings";
import { SearchProviderClient, type SearchFetch } from "../src/search-provider";

test("runtime reads current server settings on every search and passes cancellation privately", async () => {
  let saved = { provider: null as string | null, apiKey: null as string | null };
  let reads = 0;
  let searches = 0;
  const configuration = serverSearchConfiguration(
    "http://server/",
    "fixture-control-token",
    async (url, init) => {
      reads++;
      expect(url).toBe("http://server/api/internal/server-settings/web-search/credentials");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-control-token");
      expect(init.redirect).toBe("error");
      expect(init.cache).toBe("no-store");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json(saved);
    }
  );
  const client = new SearchProviderClient(configuration, async (_url, init) => {
    searches++;
    const headers = new Headers(init.headers);
    expect(headers.get(saved.provider === "exa" ? "x-api-key" : "authorization")).toBe(
      saved.provider === "exa" ? saved.apiKey : `Bearer ${saved.apiKey}`
    );
    return Response.json({
      results: [{ title: "Reference", url: "https://example.com", content: "Source" }],
    });
  });
  expect((await client.search("reference")).details.configured).toBe(false);
  expect(searches).toBe(0);
  saved = { provider: "exa", apiKey: "first-fixture-key" };
  expect((await client.search("reference")).details.provider).toBe("exa");
  saved = { provider: "tavily", apiKey: "second-fixture-key" };
  const result = await client.search("reference");
  expect(result.details.provider).toBe("tavily");
  expect(JSON.stringify(result)).not.toContain(saved.apiKey!);
  saved = { provider: null, apiKey: null };
  expect((await client.search("reference")).details.configured).toBe(false);
  expect(reads).toBe(4);
  expect(searches).toBe(2);
});

test("configuration lookup fails closed without leaking responses, URLs or tokens", async () => {
  const marker = "synthetic-private-marker";
  for (const request of [
    async () => Response.json({ error: marker }, { status: 401 }),
    async () => Response.json({ provider: "bing", apiKey: marker }),
    async () => Response.json({ provider: "exa", apiKey: 123 }),
    async () => Response.json({ provider: "exa", apiKey: "" }),
    async () => new Response(marker),
    async () => {
      throw new Error(marker);
    },
  ]) {
    const configuration = serverSearchConfiguration(
      `http://${marker}`,
      marker,
      request as SearchFetch
    );
    await expect(configuration()).rejects.toThrow("settings could not be loaded");
    try {
      await configuration();
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  }
  const abort = new AbortController();
  const configuration = serverSearchConfiguration("http://server", marker, async (_url, init) => {
    abort.abort();
    init.signal!.throwIfAborted();
    return Response.json({ provider: null, apiKey: null });
  });
  await expect(configuration(abort.signal)).rejects.toThrow();
});
