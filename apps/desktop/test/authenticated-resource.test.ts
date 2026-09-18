import { describe, expect, test } from "bun:test";
import { protectedResourceUrl } from "../src/renderer/lib/resource-url";

const apiBase = "http://127.0.0.1:3000";
const assetId = "a".repeat(64);

describe("authenticated renderer resources", () => {
  test("both canonical asset aliases require the authenticated fetch path", () => {
    for (const path of ["/api/assets/", "/api/v0/assets/"]) {
      const source = `${path}${assetId}?name=photo.png&download=1`;
      expect(protectedResourceUrl(source, apiBase)).toBe(`${apiBase}${source}`);
      expect(protectedResourceUrl(`${apiBase}${source}`, apiBase)).toBe(`${apiBase}${source}`);
    }
  });

  test("avatar and noncanonical API resources require authentication", () => {
    for (const source of ["/api/v0/bots/bot-1/avatar", "/api/v0/assets/not-a-content-hash"]) {
      expect(protectedResourceUrl(source, apiBase)).toBe(`${apiBase}${source}`);
    }
  });

  test("cross-origin, non-API, data and blob resources never receive local authentication", () => {
    for (const source of [
      `https://cdn.example.test/api/v0/assets/${assetId}`,
      `http://127.0.0.1:3001/api/v0/assets/${assetId}`,
      `http://127.0.0.1:3000.evil.test/api/v0/assets/${assetId}`,
      "//evil.test/api/v0/assets/example",
      "/logo.png",
      "data:image/png;base64,AA==",
      "blob:http://127.0.0.1:3000/example",
    ])
      expect(protectedResourceUrl(source, apiBase)).toBeNull();
  });
});
