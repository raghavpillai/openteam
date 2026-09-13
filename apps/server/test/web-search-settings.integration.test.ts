import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import {
  WebSearchSettingsService,
  parseWebSearchSettings,
} from "../src/services/web-search-settings";
import { settingsRoutes } from "../src/routes/settings";
import type { RouteContext } from "../src/routes/context";

test("search settings validate provider and credential input without echoing it", () => {
  for (const input of [
    null,
    [],
    {},
    { provider: "bing" },
    { provider: "__proto__" },
    { provider: "exa", apiKey: " " },
    { provider: "exa", apiKey: "bad\nkey" },
    { provider: "exa", apiKey: 123 },
    { provider: "exa", apiKey: "x".repeat(20_001) },
    { provider: null, apiKey: "secret" },
    { provider: "exa", configured: true },
  ]) {
    expect(() => parseWebSearchSettings(input)).toThrow();
  }
  expect(parseWebSearchSettings({ provider: "exa", apiKey: " fixture-key " })).toEqual({
    provider: "exa",
    apiKey: "fixture-key",
  });
  expect(parseWebSearchSettings({ provider: null })).toEqual({ provider: null });
});

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "search settings persist directly in PostgreSQL with safe public API and atomic changes",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const key = "synthetic-search-credential-never-public";
    const service = new WebSearchSettingsService(prisma);
    const request = async (method: string, input?: unknown) => {
      const path = "/api/server-settings/web-search";
      const url = new URL(`http://localhost${path}`);
      const response = await settingsRoutes({
        app: { webSearchSettings: service },
        path,
        url,
        request: new Request(url, {
          method,
          ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
        }),
      } as RouteContext);
      expect(response!.headers.get("cache-control")).toContain("no-store");
      const text = await response!.text();
      expect(text).not.toContain(key);
      expect(JSON.parse(text)).not.toHaveProperty("apiKey");
      return JSON.parse(text);
    };
    try {
      await prisma.webSearchSettings.deleteMany();
      expect(await request("GET")).toEqual({ provider: null, hasApiKey: false, configured: false });
      expect(await service.credentials()).toEqual({ provider: null, apiKey: null });
      expect(await request("PATCH", { provider: "exa", apiKey: key })).toEqual({
        provider: "exa",
        hasApiKey: true,
        configured: true,
      });
      const row = await prisma.webSearchSettings.findUniqueOrThrow({ where: { id: "global" } });
      expect(row.apiKey).toBe(key);
      const restarted = new WebSearchSettingsService(prisma);
      expect(await restarted.credentials()).toEqual({ provider: "exa", apiKey: key });
      await request("PATCH", { provider: "exa" });
      expect(await service.credentials()).toEqual({ provider: "exa", apiKey: key });

      // Changing providers may never implicitly send another provider's credential.
      expect(await request("PATCH", { provider: "tavily" })).toEqual({
        provider: "tavily",
        hasApiKey: false,
        configured: false,
      });
      expect(await service.credentials()).toEqual({ provider: "tavily", apiKey: null });
      await service.save({ provider: "tavily", apiKey: key });
      await service.save({ provider: "tavily", apiKey: null });
      expect((await service.view()).hasApiKey).toBe(false);

      await service.save({ provider: "exa", apiKey: key });
      expect((await service.view()).configured).toBe(true);
      await service.save({ provider: null });
      expect(await service.credentials()).toEqual({ provider: null, apiKey: null });

      // Separate service instances serialize their writes through a DB transaction lock.
      await Promise.all([
        service.save({ provider: "exa", apiKey: key }),
        restarted.save({ provider: "tavily", apiKey: "second-fixture-key" }),
      ]);
      const final = await service.credentials();
      expect(final.apiKey).toBe(final.provider === "exa" ? key : "second-fixture-key");
      expect(await prisma.webSearchSettings.count()).toBe(1);
      await expect(
        Promise.resolve(prisma.webSearchSettings.create({ data: { id: "another" } }))
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          prisma.webSearchSettings.update({ where: { id: "global" }, data: { provider: "bing" } })
        )
      ).rejects.toThrow();
    } finally {
      await prisma.webSearchSettings.deleteMany();
      await prisma.$disconnect();
    }
  }
);

test("database write errors cannot leak the plaintext search API key", async () => {
  const key = "synthetic-key-in-a-database-error";
  const service = new WebSearchSettingsService({
    $transaction: async () => {
      throw new Error(`Query failed with apiKey: ${key}`);
    },
  } as never);
  try {
    await service.save({ provider: "exa", apiKey: key });
    throw new Error("Expected a failure");
  } catch (error) {
    expect(error).toMatchObject({ status: 503, code: "web_search_settings_save_failed" });
    expect(String(error)).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(key);
  }
});
