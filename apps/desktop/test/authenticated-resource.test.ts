import { describe, expect, test } from "bun:test";
import { canonicalPublicAssetUrl, protectedResourceUrl } from "../src/renderer/lib/resource-url";

const apiBase = "http://127.0.0.1:3000";
const assetId = "a".repeat(64);

describe("authenticated renderer resources", () => {
  test("does not schedule a blob fetch for direct canonical assets", async () => {
    const hook = await Bun.file(
      new URL("../src/renderer/hooks/use-authenticated-resource.ts", import.meta.url)
    ).text();

    expect(hook).toContain("source && !directAsset");
    expect(hook).toContain("if (directAsset)");
    expect(hook).toContain("fetch(target");
    expect(hook).toContain("return directAsset ?? resolved");
  });

  test("canonical content-addressed assets use direct lazy-loadable URLs", () => {
    const source = `/api/v0/assets/${assetId}?name=photo.png`;

    expect(canonicalPublicAssetUrl(source, apiBase)).toBe(`${apiBase}${source}`);
  });

  test("noncanonical API resources stay on the authenticated fetch path", () => {
    for (const source of [
      "/api/v0/bots/bot-1/avatar",
      "/api/v0/assets/not-a-content-hash",
      `/api/v0/assets/${"A".repeat(64)}`,
    ]) {
      expect(canonicalPublicAssetUrl(source, apiBase)).toBeNull();
      expect(protectedResourceUrl(source, apiBase)).toBe(`${apiBase}${source}`);
    }
  });

  test("cross-origin resources never receive local authentication", () => {
    const source = `https://cdn.example.test/api/v0/assets/${assetId}`;

    expect(canonicalPublicAssetUrl(source, apiBase)).toBeNull();
    expect(protectedResourceUrl(source, apiBase)).toBeNull();
  });
});
