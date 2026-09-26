import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { FETCH_PROVIDER_LIST, SEARCH_PROVIDER_LIST } from "@openteam/contracts/web-search";
import {
  parseWebProviderSettings,
  WebProviderSettingsService,
  type WebProviderChecker,
} from "../src/services/web-provider-settings";
import { settingsRoutes } from "../src/routes/settings";
import type { RouteContext } from "../src/routes/context";
import { errorResponse } from "../src/http";

test("provider settings validate tools, providers and fields without echoing them", () => {
  for (const input of [
    null,
    [],
    { searches: {} },
    { search: "exa" },
    { search: { selected: "bing" } },
    { search: { selected: "builtin" } },
    { search: { selected: "exa-free" } },
    { fetch: { selected: "exa-free" } },
    { search: { providers: { google: { apiKey: "k" } } } },
    { search: { providers: { exa: { baseUrl: "https://x" } } } },
    { search: { providers: { exa: { apiKey: " " } } } },
    { search: { providers: { exa: { apiKey: "bad\nkey" } } } },
    { search: { providers: { exa: { apiKey: "two words" } } } },
    { search: { providers: { exa: { apiKey: 123 } } } },
    { fetch: { providers: { builtin: { apiKey: "k" } } } },
    // Providers that are no longer offered.
    { search: { selected: "tavily" } },
    { search: { providers: { searxng: { baseUrl: "https://searx.example" } } } },
    { fetch: { selected: "cloudflare" } },
    { search: { selected: "exa", configured: true } },
  ])
    expect(() => parseWebProviderSettings(input)).toThrow();
  expect(
    parseWebProviderSettings({
      search: { selected: "bing-serpapi", providers: { "bing-serpapi": { apiKey: " serp-key " }, exa: { apiKey: null } } },
      fetch: { selected: null, providers: { firecrawl: { apiKey: " fc-key " } } },
    })
  ).toEqual({
    search: { selected: "bing-serpapi", providers: { "bing-serpapi": { apiKey: "serp-key" }, exa: { apiKey: null } } },
    fetch: { selected: null, providers: { firecrawl: { apiKey: "fc-key" } } },
  });
});

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const reset = async (prisma: ReturnType<typeof createPrismaClient>) => {
  await prisma.webSearchSettings.deleteMany();
  await prisma.webFetchSettings.deleteMany();
  await prisma.webToolProvider.deleteMany();
};

test.skipIf(!databaseUrl)(
  "search and fetch keep separate providers, safe defaults and a secret-free public API",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const searchKey = "synthetic-exa-search-key-never-public";
    const fetchKey = "synthetic-exa-fetch-key-never-public";
    const service = new WebProviderSettingsService(prisma);
    const request = async (path: string, method: string, input?: unknown) => {
      const url = new URL(`http://localhost${path}`);
      // main.ts turns thrown API errors into responses; mirror that here.
      const response = await settingsRoutes({
        app: { webProviders: service },
        path,
        url,
        request: new Request(url, { method, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) }),
      } as RouteContext).catch(errorResponse);
      expect(response!.headers.get("cache-control")).toContain("no-store");
      const text = await response!.text();
      expect(text).not.toContain(searchKey);
      expect(text).not.toContain(fetchKey);
      return { status: response!.status, body: JSON.parse(text) };
    };
    const patch = (input: unknown) => request("/api/server-settings/web-providers", "PATCH", input);
    try {
      await reset(prisma);
      // Fresh install: search is off, fetch uses the built-in reader; every provider is listed.
      const fresh = (await request("/api/server-settings/web-providers", "GET")).body;
      expect(fresh.search.selected).toBeNull();
      expect(fresh.fetch.selected).toBe("builtin");
      expect(Object.keys(fresh.search.providers)).toEqual(SEARCH_PROVIDER_LIST.map((p) => p.id));
      expect(Object.keys(fresh.fetch.providers)).toEqual(FETCH_PROVIDER_LIST.map((p) => p.id));
      // Only the built-in fetcher is ready without setup; every third-party provider needs its key.
      expect(fresh.fetch.providers.builtin).toEqual({ secretSaved: false, ready: true, check: null });
      for (const tool of ["search", "fetch"] as const)
        for (const [id, state] of Object.entries(fresh[tool].providers))
          if (id !== "builtin") expect(state).toMatchObject({ ready: false });
      expect(await service.credentials("search")).toEqual({ provider: null, apiKey: null });
      expect(await service.credentials("fetch")).toEqual({ provider: "builtin", apiKey: null });

      // A provider cannot be selected without its API key.
      const rejected = await patch({ search: { selected: "exa" } });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.message).toBe("Add the Exa API key to use it for search.");

      // Search and fetch keep separate keys for the same provider.
      await patch({ search: { selected: "exa", providers: { exa: { apiKey: searchKey } } } });
      const noFetchKey = await patch({ fetch: { selected: "exa" } });
      expect(noFetchKey.body.error.message).toBe("Add the Exa API key to use it for fetch.");
      await patch({ fetch: { selected: "exa", providers: { exa: { apiKey: fetchKey } } } });
      const restarted = new WebProviderSettingsService(prisma);
      expect(await restarted.credentials("search")).toEqual({ provider: "exa", apiKey: searchKey });
      expect(await restarted.credentials("fetch")).toEqual({ provider: "exa", apiKey: fetchKey });

      // A key in use cannot be removed until the tool moves elsewhere.
      const inUse = await patch({ search: { providers: { exa: { apiKey: null } } } });
      expect(inUse.body.error.message).toBe("Exa is used for search. Choose another search provider before removing its API key.");
      await patch({ search: { selected: null, providers: { exa: { apiKey: null } } } });
      expect(await service.credentials("search")).toEqual({ provider: null, apiKey: null });
      expect(await service.credentials("fetch")).toEqual({ provider: "exa", apiKey: fetchKey });

      // Saving the same key again is not a change.
      await patch({ fetch: { selected: "firecrawl", providers: { firecrawl: { apiKey: "fc-token" } } } });
      expect(await service.credentials("fetch")).toEqual({ provider: "firecrawl", apiKey: "fc-token" });
      const view = (await request("/api/server-settings/web-providers", "GET")).body;
      expect(view.fetch.providers.firecrawl).toEqual({ secretSaved: true, ready: true, check: null });
      expect(JSON.stringify(view)).not.toContain("fc-token");
      const before = await prisma.webToolProvider.findUniqueOrThrow({ where: { tool_provider: { tool: "fetch", provider: "firecrawl" } } });
      await patch({ fetch: { providers: { firecrawl: { apiKey: "fc-token" } } } });
      const after = await prisma.webToolProvider.findUniqueOrThrow({ where: { tool_provider: { tool: "fetch", provider: "firecrawl" } } });
      expect(after.updatedAt).toEqual(before.updatedAt);

      // Both tools can be off.
      await patch({ search: { selected: null }, fetch: { selected: null } });
      expect(await service.credentials("search")).toEqual({ provider: null, apiKey: null });
      expect(await service.credentials("fetch")).toEqual({ provider: null, apiKey: null });

      // Legacy endpoints keep older clients working against the new storage.
      expect((await request("/api/server-settings/web-search", "PATCH", { provider: "tavily", apiKey: "tvly-legacy" })).status).toBe(400);
      expect((await request("/api/server-settings/web-search", "PATCH", { provider: "brave", apiKey: "brave-legacy" })).body).toEqual({
        provider: "brave",
        hasApiKey: true,
        configured: true,
      });
      expect((await request("/api/server-settings/web-fetch", "PATCH", { provider: "builtin" })).body).toEqual({
        provider: "builtin",
        hasApiKey: false,
        configured: true,
      });
      expect((await request("/api/server-settings/web-search", "PATCH", { provider: "brave", apiKey: null })).body).toEqual({
        provider: null,
        hasApiKey: false,
        configured: false,
      });

      // Separate service instances serialize their writes through a transaction lock.
      await Promise.all([
        service.save({ search: { selected: "exa", providers: { exa: { apiKey: searchKey } } } }),
        restarted.save({ search: { selected: "brave", providers: { brave: { apiKey: "brave-fixture-key" } } } }),
      ]);
      const final = await service.credentials("search");
      expect(final.apiKey).toBe(final.provider === "exa" ? searchKey : "brave-fixture-key");
    } finally {
      await reset(prisma);
      await prisma.$disconnect();
    }
  }
);

test.skipIf(!databaseUrl)("connection checks run with the saved key and store their outcome", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const requests: Parameters<WebProviderChecker>[0][] = [];
  let outcome: { ok: boolean; message: string } | Error = { ok: true, message: "Returned 3 results." };
  let during: (() => Promise<unknown>) | undefined;
  const service = new WebProviderSettingsService(prisma, async (request) => {
    requests.push(request);
    await during?.();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  try {
    await reset(prisma);
    await expect(service.check({ tool: "search", provider: "exa" })).rejects.toThrow("Add the Exa API key before checking it.");
    await expect(service.check({ tool: "search", provider: "builtin" })).rejects.toThrow("Unknown search provider.");

    await service.save({ search: { providers: { exa: { apiKey: "exa-check-key" } } } });
    let view = await service.check({ tool: "search", provider: "exa" });
    expect(requests.at(-1)).toEqual({ tool: "search", provider: "exa", apiKey: "exa-check-key" });
    expect(view.search.providers.exa!.check).toMatchObject({ status: "passed", message: "Returned 3 results." });
    expect(Date.parse(view.search.providers.exa!.check!.checkedAt)).toBeGreaterThan(Date.now() - 60_000);
    // Checks are per tool: fetch Exa has not been checked.
    expect(view.fetch.providers.exa!.check).toBeNull();

    // The built-in fetcher can be checked and stores a row without a secret.
    outcome = { ok: false, message: "The site did not respond within 20 seconds" };
    view = await service.check({ tool: "fetch", provider: "builtin" });
    expect(view.fetch.providers.builtin).toMatchObject({ secretSaved: false, check: { status: "failed" } });
    expect(requests.at(-1)).toEqual({ tool: "fetch", provider: "builtin", apiKey: null });

    // Changing a provider's key clears its stored check.
    view = await service.save({ search: { providers: { exa: { apiKey: "exa-rotated-key" } } } });
    expect(view.search.providers.exa!.check).toBeNull();

    // A result for a key that changed mid-check is discarded.
    outcome = { ok: true, message: "stale" };
    during = () => service.save({ search: { providers: { exa: { apiKey: "exa-newer-key" } } } });
    view = await service.check({ tool: "search", provider: "exa" });
    expect(view.search.providers.exa!.check).toBeNull();
    during = undefined;

    // An unreachable computer fails the request without storing anything.
    outcome = new Error("connect ECONNREFUSED");
    await expect(service.check({ tool: "search", provider: "exa" })).rejects.toMatchObject({ status: 503 });
    expect((await service.view()).search.providers.exa!.check).toBeNull();
  } finally {
    await reset(prisma);
    await prisma.$disconnect();
  }
});

test.skipIf(!databaseUrl)("database constraints accept every catalog provider and reject invalid rows", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  try {
    await reset(prisma);
    for (const provider of SEARCH_PROVIDER_LIST) {
      await prisma.webSearchSettings.upsert({ where: { id: "global" }, create: { id: "global", provider: provider.id }, update: { provider: provider.id } });
      await prisma.webToolProvider.create({ data: { tool: "search", provider: provider.id } });
    }
    for (const provider of FETCH_PROVIDER_LIST) {
      await prisma.webFetchSettings.upsert({ where: { id: "global" }, create: { id: "global", provider: provider.id }, update: { provider: provider.id } });
      await prisma.webToolProvider.create({ data: { tool: "fetch", provider: provider.id } });
    }
    for (const data of [
      { tool: "search", provider: "builtin" },
      { tool: "fetch", provider: "exa-free" },
      { tool: "search", provider: "exa-free" },
      { tool: "other", provider: "exa" },
      { tool: "search", provider: "google" },
      { tool: "search", provider: "tavily" },
      { tool: "fetch", provider: "cloudflare" },
    ])
      await expect(Promise.resolve(prisma.webToolProvider.create({ data }))).rejects.toThrow();
    const exa = { tool_provider: { tool: "search", provider: "exa" } };
    await expect(Promise.resolve(prisma.webToolProvider.update({ where: exa, data: { secret: " " } }))).rejects.toThrow();
    await expect(Promise.resolve(prisma.webToolProvider.update({ where: exa, data: { checkStatus: "maybe", checkedAt: new Date() } }))).rejects.toThrow();
    await expect(Promise.resolve(prisma.webToolProvider.update({ where: exa, data: { checkStatus: "passed" } }))).rejects.toThrow();
    await expect(Promise.resolve(prisma.webSearchSettings.create({ data: { id: "another" } }))).rejects.toThrow();
    await expect(Promise.resolve(prisma.webSearchSettings.update({ where: { id: "global" }, data: { apiKey: "legacy" } }))).rejects.toThrow();
  } finally {
    await reset(prisma);
    await prisma.$disconnect();
  }
});

test.skipIf(!databaseUrl)("raw schema moves legacy keys and drops providers no longer offered", async () => {
  // The raw-schema script reads DATABASE_URL when it is loaded.
  process.env.DATABASE_URL = databaseUrl;
  const { applyRawSchema } = await import("../../../packages/db/scripts/apply-raw-schema");
  const prisma = createPrismaClient(databaseUrl!);
  const legacy = async () => {
    for (const table of ["WebSearchSettings", "WebFetchSettings", "WebToolProvider"])
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${table}_valid"`);
    await reset(prisma);
  };
  const rows = async () =>
    (await prisma.webToolProvider.findMany({ orderBy: [{ tool: "asc" }, { provider: "asc" }] })).map((row) => `${row.tool}:${row.provider}`);
  try {
    await legacy();
    await prisma.webSearchSettings.create({ data: { id: "global", provider: "bing-serpapi", apiKey: "legacy-serp" } });
    await prisma.webFetchSettings.create({ data: { id: "global", provider: "tavily", apiKey: "legacy-tavily" } });
    await applyRawSchema();
    const service = new WebProviderSettingsService(prisma);
    expect(await service.credentials("search")).toEqual({ provider: "bing-serpapi", apiKey: "legacy-serp" });
    // Tavily is no longer offered: its key is not kept and fetch falls back to built-in.
    expect(await service.credentials("fetch")).toEqual({ provider: "builtin", apiKey: null });
    expect(await rows()).toEqual(["search:bing-serpapi"]);
    expect((await prisma.webSearchSettings.findUniqueOrThrow({ where: { id: "global" } })).apiKey).toBeNull();

    // A legacy selection that never had a key is cleared; fetch falls back to built-in.
    await legacy();
    await prisma.webSearchSettings.create({ data: { id: "global", provider: "brave" } });
    await prisma.webFetchSettings.create({ data: { id: "global", provider: "exa" } });
    await applyRawSchema();
    expect(await service.view()).toMatchObject({ search: { selected: null }, fetch: { selected: "builtin" } });

    // Entries and selections for providers no longer offered are removed; others are kept.
    await legacy();
    await prisma.webSearchSettings.create({ data: { id: "global", provider: "tavily", apiKey: "legacy-tavily" } });
    await prisma.webFetchSettings.create({ data: { id: "global", provider: "cloudflare" } });
    await prisma.webToolProvider.createMany({
      data: [
        { tool: "search", provider: "searxng" },
        { tool: "fetch", provider: "cloudflare", secret: "cf-token" },
        { tool: "fetch", provider: "firecrawl", secret: "fc-token", checkStatus: "passed", checkMessage: "ok", checkedAt: new Date() },
      ],
    });
    await applyRawSchema();
    expect(await service.view()).toMatchObject({
      search: { selected: null },
      fetch: { selected: "builtin", providers: { firecrawl: { secretSaved: true, check: { status: "passed" } } } },
    });
    expect(await rows()).toEqual(["fetch:firecrawl"]);
  } finally {
    await reset(prisma);
    await prisma.$disconnect();
  }
});

test("database write errors cannot leak plaintext provider secrets", async () => {
  const key = "synthetic-key-in-a-database-error";
  const service = new WebProviderSettingsService({
    $transaction: async () => {
      throw new Error(`Query failed with secret: ${key}`);
    },
  } as never);
  try {
    await service.save({ search: { selected: "exa", providers: { exa: { apiKey: key } } } });
    throw new Error("Expected a failure");
  } catch (error) {
    expect(error).toMatchObject({ status: 503, code: "web_provider_settings_save_failed" });
    expect(String(error)).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(key);
  }
});
