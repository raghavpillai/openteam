import { describe, expect, test } from "bun:test";
import { protectedResourceUrl, resourceCacheUrl } from "../src/renderer/lib/resource-url";

const apiBase = "http://127.0.0.1:3000";
const assetId = "a".repeat(64);

describe("authenticated renderer resources", () => {
  test("immutable aliases and filenames share a cache key without combining origins or renditions", () => {
    const canonical = `${apiBase}/api/v0/assets/${assetId}`;
    expect(resourceCacheUrl(`${apiBase}/api/assets/${assetId}?name=renamed.png&download=1`)).toBe(
      canonical
    );
    expect(resourceCacheUrl(`${canonical}?name=original.png`)).toBe(canonical);
    expect(resourceCacheUrl(`${canonical}?preview=640&name=original.png`)).toBe(
      `${canonical}?preview=640`
    );
    expect(resourceCacheUrl(`${canonical}?preview=1280`)).not.toBe(
      resourceCacheUrl(`${canonical}?preview=640`)
    );
    expect(resourceCacheUrl(`https://other.example/api/assets/${assetId}`)).not.toBe(canonical);
    const mutable = `${apiBase}/api/v0/bots/bot-1/avatar?name=photo.png&revision=2`;
    expect(resourceCacheUrl(mutable)).toBe(mutable);
  });
  test("only exact immutable asset paths drop presentation parameters", () => {
    for (const target of [
      `${apiBase}/api/v0/assets/${assetId}/preview?name=photo.png&download=1`,
      `${apiBase}/api/v0/assets/${assetId}/?name=photo.png`,
      `${apiBase}/api/v0/assets/not-a-hash?name=photo.png&download=1`,
      `${apiBase}/api/v0/bots/fixture/avatar?name=photo.png&download=1`,
    ])
      expect(resourceCacheUrl(target)).toBe(target);
    const canonical = `${apiBase}/api/v0/assets/${assetId}`;
    expect(
      resourceCacheUrl(`${canonical}?name=one&name=two&download=1&format=webp&width=640`)
    ).toBe(`${canonical}?format=webp&width=640`);
    expect(resourceCacheUrl(`${canonical}?format=png&width=640`)).not.toBe(
      resourceCacheUrl(`${canonical}?format=webp&width=640`)
    );
    expect(resourceCacheUrl(`${canonical}?width=640&revision=1`)).not.toBe(
      resourceCacheUrl(`${canonical}?width=640&revision=2`)
    );
  });
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
