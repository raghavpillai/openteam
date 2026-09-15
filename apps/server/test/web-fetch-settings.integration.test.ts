import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { WebFetchSettingsService, parseWebFetchSettings } from "../src/services/web-fetch-settings";
import { settingsRoutes } from "../src/routes/settings";
import type { RouteContext } from "../src/routes/context";
test("fetch settings only allow implemented providers and bounded keys", () => {
  for (const value of [
    null,
    { provider: "brave" },
    { provider: null },
    { provider: "builtin", apiKey: "key" },
    { provider: "exa", apiKey: "\n" },
    { provider: "exa", apiKey: 12 },
  ])
    expect(() => parseWebFetchSettings(value)).toThrow();
  expect(parseWebFetchSettings({ provider: "builtin" })).toEqual({ provider: "builtin" });
  expect(parseWebFetchSettings({ provider: "tavily", apiKey: " key " })).toEqual({
    provider: "tavily",
    apiKey: "key",
  });
});
const db = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!db)(
  "fetch settings use plain DB storage, default to built-in, and never return keys publicly",
  async () => {
    const prisma = createPrismaClient(db!);
    const service = new WebFetchSettingsService(prisma);
    const key = "synthetic-fetch-db-key";
    const request = async (method: string, input?: unknown) => {
      const path = "/api/server-settings/web-fetch",
        url = new URL("http://localhost" + path);
      const response = await settingsRoutes({
        app: { webFetchSettings: service },
        path,
        url,
        request: new Request(url, { method, ...(input ? { body: JSON.stringify(input) } : {}) }),
      } as RouteContext);
      const body = await response!.json();
      expect(body).not.toHaveProperty("apiKey");
      expect(JSON.stringify(body)).not.toContain(key);
      expect(response!.headers.get("cache-control")).toContain("no-store");
      return body;
    };
    try {
      await prisma.webFetchSettings.deleteMany();
      expect(await request("GET")).toEqual({
        provider: "builtin",
        hasApiKey: false,
        configured: true,
      });
      expect(await service.credentials()).toEqual({ provider: "builtin", apiKey: null });
      expect(await request("PATCH", { provider: "exa", apiKey: key })).toEqual({
        provider: "exa",
        hasApiKey: true,
        configured: true,
      });
      expect(
        (await prisma.webFetchSettings.findUniqueOrThrow({ where: { id: "global" } })).apiKey
      ).toBe(key);
      expect(await new WebFetchSettingsService(prisma).credentials()).toEqual({
        provider: "exa",
        apiKey: key,
      });
      await service.save({ provider: "exa" });
      expect((await service.credentials()).apiKey).toBe(key);
      await service.save({ provider: "tavily" });
      expect(await service.credentials()).toEqual({ provider: "tavily", apiKey: null });
      await service.save({ provider: "tavily", apiKey: key });
      await service.save({ provider: "tavily", apiKey: null });
      expect((await service.view()).configured).toBe(false);
      await service.save({ provider: "exa", apiKey: key });
      await service.save({ provider: "builtin" });
      expect(await service.credentials()).toEqual({ provider: "builtin", apiKey: null });
      expect(await prisma.webFetchSettings.count()).toBe(1);
    } finally {
      await prisma.webFetchSettings.deleteMany();
      await prisma.$disconnect();
    }
  }
);
test("fetch database failures do not expose plaintext keys", async () => {
  const key = "synthetic-fetch-error-key";
  const service = new WebFetchSettingsService({
    $transaction: async () => {
      throw new Error(key);
    },
  } as never);
  try {
    await service.save({ provider: "exa", apiKey: key });
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toMatchObject({ code: "web_fetch_settings_save_failed" });
    expect(String(error)).not.toContain(key);
  }
});
