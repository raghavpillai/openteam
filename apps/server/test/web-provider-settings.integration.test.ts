import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { FETCH_PROVIDER_LIST, SEARCH_PROVIDER_LIST } from "@openteam/contracts/web-search";
import { WebProviderSettingsService } from "../src/services/web-provider-settings";
import { settingsRoutes } from "../src/routes/settings";
import type { RouteContext } from "../src/routes/context";
import { errorResponse } from "../src/http";

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
