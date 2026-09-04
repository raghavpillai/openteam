import { describe, expect, test } from "bun:test";
import { browserCookieInternals, browserStateInternals } from "../../src/browser/broker";

describe("computer-scoped browser authority", () => {
  test("keys cookies by name, domain, path, and partition", () => {
    const first = {
      name: "session",
      value: "one",
      domain: ".example.com",
      path: "/",
      partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false },
    };
    expect(browserCookieInternals.cookieKey(first)).toBe(
      browserCookieInternals.cookieKey({ ...first, value: "two" })
    );
    expect(browserCookieInternals.cookieKey(first)).not.toBe(
      browserCookieInternals.cookieKey({ ...first, path: "/admin" })
    );
  });

  test("emits only CDP-settable cookie fields", () => {
    expect(
      browserCookieInternals.cookieParameter({
        name: "session",
        value: "secret",
        domain: ".example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expires: 2_000_000_000,
        size: 128,
        session: false,
      })
    ).toEqual({
      name: "session",
      value: "secret",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expires: 2_000_000_000,
    });
  });

  test("normalizes routable origins and ignores volatile capture timestamps", () => {
    expect(browserStateInternals.originForUrl("https://example.com/path?q=1")).toBe(
      "https://example.com"
    );
    expect(browserStateInternals.originForUrl("chrome://settings")).toBeNull();
    expect(
      browserStateInternals.stateDigest({
        origin: "https://example.com",
        capturedAt: "2026-01-01T00:00:00.000Z",
        localStorage: [["session", "one"]],
      })
    ).toBe(
      browserStateInternals.stateDigest({
        origin: "https://example.com",
        capturedAt: "2026-01-02T00:00:00.000Z",
        localStorage: [["session", "one"]],
      })
    );
  });

  test("exports and restores every live origin-state family", () => {
    expect(() => new Function(`return ${browserStateInternals.exportExpression}`)).not.toThrow();
    expect(() => new Function(`return (${browserStateInternals.importFunction})`)).not.toThrow();
    for (const marker of [
      "localStorage",
      "indexedDb",
      "cacheStorage",
      "serviceWorkers",
      "indexedDB.databases",
      "navigator.serviceWorker",
    ]) {
      expect(browserStateInternals.exportExpression).toContain(marker);
      expect(
        browserStateInternals.importFunction.includes(marker) || marker === "indexedDB.databases"
      ).toBeTrue();
    }
  });
});
