import { describe, expect, test } from "bun:test";
import { authRequestWithClientIp, loginOriginAllowed } from "../../src/auth-request";

const proxySecret = "openteam-test-proxy-secret-that-is-at-least-32-characters";

describe("authentication client attribution", () => {
  test("ignores spoofed forwarding headers on a direct request", async () => {
    const request = new Request("http://openteam.test/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.8",
        "x-openteam-client-ip": "198.51.100.9",
        "x-openteam-proxy": "wrong-secret",
      },
      body: JSON.stringify({ username: "owner" }),
    });
    const attributed = authRequestWithClientIp(
      request,
      { requestIP: () => ({ address: "203.0.113.7" }) },
      proxySecret,
      undefined,
      await request.text()
    );

    expect(attributed.headers.get("x-openteam-client-ip")).toBe("203.0.113.7");
    expect(attributed.headers.has("x-forwarded-for")).toBe(false);
    expect(attributed.headers.has("x-openteam-proxy")).toBe(false);
  });

  test("accepts Caddy's client address only with the shared proxy proof", () => {
    const request = new Request("http://server:8787/api/auth/config", {
      headers: {
        "x-forwarded-for": "198.51.100.8",
        "x-forwarded-proto": "https",
        "x-openteam-proxy": proxySecret,
      },
    });
    const attributed = authRequestWithClientIp(
      request,
      { requestIP: () => ({ address: "172.20.0.5" }) },
      proxySecret
    );

    expect(attributed.headers.get("x-openteam-client-ip")).toBe("198.51.100.8");
    expect(attributed.headers.has("x-forwarded-proto")).toBe(false);
  });

  test("accepts a private upstream's forwarded address only in external-proxy mode", () => {
    const request = new Request("http://server:8787/api/auth/config", {
      headers: { "x-forwarded-for": "198.51.100.42" },
    });
    const attributed = authRequestWithClientIp(
      request,
      { requestIP: () => ({ address: "172.20.0.1" }) },
      proxySecret,
      undefined,
      undefined,
      { trustPrivateForwarder: true }
    );

    expect(attributed.headers.get("x-openteam-client-ip")).toBe("198.51.100.42");
  });

  test("does not trust a client-prepended forwarded address", () => {
    const request = new Request("http://server:8787/api/auth/config", {
      headers: { "x-forwarded-for": "198.51.100.99, 198.51.100.42" },
    });
    const attributed = authRequestWithClientIp(
      request,
      { requestIP: () => ({ address: "172.20.0.1" }) },
      proxySecret,
      undefined,
      undefined,
      { trustPrivateForwarder: true }
    );

    expect(attributed.headers.get("x-openteam-client-ip")).toBe("198.51.100.42");
  });

  test("recognizes IPv4-mapped and private IPv6 proxy addresses", () => {
    for (const address of ["::ffff:172.20.0.1", "fd00::1", "fe80::1"]) {
      const attributed = authRequestWithClientIp(
        new Request("http://server:8787/api/auth/config", {
          headers: { "x-forwarded-for": "2001:db8::42" },
        }),
        { requestIP: () => ({ address }) },
        proxySecret,
        undefined,
        undefined,
        { trustPrivateForwarder: true }
      );

      expect(attributed.headers.get("x-openteam-client-ip")).toBe("2001:db8::42");
    }
  });

  test("gives native login requests the server origin without trusting a supplied origin", async () => {
    for (const suppliedOrigin of [undefined, "null"]) {
      const request = new Request("https://team.example.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "better-auth.session_token=stale.invalid",
          ...(suppliedOrigin ? { origin: suppliedOrigin } : {}),
        },
        body: JSON.stringify({ username: "owner", password: "secret" }),
      });
      const attributed = authRequestWithClientIp(
        request,
        { requestIP: () => ({ address: "203.0.113.7" }) },
        proxySecret,
        new URL("/api/auth/sign-in/username", request.url),
        await request.text(),
        { fallbackOrigin: "https://team.example.test", stripCookies: true }
      );

      expect(attributed.headers.get("origin")).toBe("https://team.example.test");
      expect(attributed.headers.has("cookie")).toBe(false);
    }

    const crossOrigin = new Request("https://team.example.test/api/auth/login", {
      method: "POST",
      headers: { origin: "https://untrusted.example.test" },
      body: "{}",
    });
    const attributed = authRequestWithClientIp(
      crossOrigin,
      { requestIP: () => ({ address: "203.0.113.7" }) },
      proxySecret,
      undefined,
      await crossOrigin.text(),
      { fallbackOrigin: "https://team.example.test" }
    );
    expect(attributed.headers.get("origin")).toBe("https://untrusted.example.test");
    expect(loginOriginAllowed(crossOrigin, "https://team.example.test")).toBe(false);
    expect(
      loginOriginAllowed(
        new Request("https://team.example.test/api/auth/login", {
          headers: { origin: "https://team.example.test" },
        }),
        "https://team.example.test"
      )
    ).toBe(true);
    expect(
      loginOriginAllowed(
        new Request("https://team.example.test/api/auth/login"),
        "https://team.example.test"
      )
    ).toBe(true);
  });
});
