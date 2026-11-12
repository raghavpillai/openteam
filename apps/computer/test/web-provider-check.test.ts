import { expect, test } from "bun:test";
import { checkWebProvider, parseWebProviderCheck } from "../src/web-provider-check";
import type { SearchFetch } from "../src/search-provider";

test("check requests are validated before anything runs", () => {
  for (const input of [
    null,
    { tool: "browse", provider: "exa", apiKey: null },
    { tool: "search", provider: "builtin", apiKey: null },
    { tool: "search", provider: "exa-free", apiKey: null },
    { tool: "search", provider: "exa", apiKey: "" },
    { tool: "search", provider: "tavily", apiKey: "k" },
    { tool: "fetch", provider: "cloudflare", apiKey: "k" },
  ])
    expect(() => parseWebProviderCheck(input)).toThrow("Invalid web provider check");
  expect(parseWebProviderCheck({ tool: "fetch", provider: "parallel", apiKey: "t", extra: 1 })).toEqual({ tool: "fetch", provider: "parallel", apiKey: "t" });
});

test("a search check passes with results and fails with the provider's reason", async () => {
  const respond = (response: Response): SearchFetch => async () => response;
  const passed = await checkWebProvider(
    { tool: "search", provider: "exa", apiKey: "k" },
    undefined,
    respond(Response.json({ results: [{ title: "OpenTeam", url: "https://example.com/a", highlights: ["x"] }, { url: "https://example.com/b" }] }))
  );
  expect(passed).toEqual({ ok: true, message: "Search works: 2 results for a test query." });
  const empty = await checkWebProvider({ tool: "search", provider: "exa", apiKey: "k" }, undefined, respond(Response.json({ results: [] })));
  expect(empty).toEqual({ ok: false, message: "The provider answered, but returned no results for a test query." });
  const rejected = await checkWebProvider(
    { tool: "search", provider: "brave", apiKey: "bad" },
    undefined,
    respond(Response.json({ error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: "The provided subscription token is invalid." } }, { status: 422 }))
  );
  expect(rejected.ok).toBe(false);
  expect(rejected.message).toContain("Check the configured API key");
  const missing = await checkWebProvider({ tool: "search", provider: "bing-serpapi", apiKey: null });
  expect(missing).toMatchObject({ ok: false, message: expect.stringContaining("Bing is selected but its API key is missing") });
});

