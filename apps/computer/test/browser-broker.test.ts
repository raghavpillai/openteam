import { describe, expect, test } from "bun:test";
import { browserCookieInternals } from "../src/browser-broker";

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
});
