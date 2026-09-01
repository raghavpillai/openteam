import { describe, expect, test } from "bun:test";
import { authRequestWithClientIp } from "../src/auth-request";

const proxySecret = "openbot-test-proxy-secret-that-is-at-least-32-characters";

describe("authentication client attribution", () => {
  test("ignores spoofed forwarding headers on a direct request", async () => {
    const request = new Request("http://openbot.test/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.8",
        "x-openbot-client-ip": "198.51.100.9",
        "x-openbot-proxy": "wrong-secret",
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

    expect(attributed.headers.get("x-openbot-client-ip")).toBe("203.0.113.7");
    expect(attributed.headers.has("x-forwarded-for")).toBe(false);
    expect(attributed.headers.has("x-openbot-proxy")).toBe(false);
  });

  test("accepts Caddy's client address only with the shared proxy proof", () => {
    const request = new Request("http://server:8787/api/auth/config", {
      headers: {
        "x-forwarded-for": "198.51.100.8",
        "x-forwarded-proto": "https",
        "x-openbot-proxy": proxySecret,
      },
    });
    const attributed = authRequestWithClientIp(
      request,
      { requestIP: () => ({ address: "172.20.0.5" }) },
      proxySecret
    );

    expect(attributed.headers.get("x-openbot-client-ip")).toBe("198.51.100.8");
    expect(attributed.headers.has("x-forwarded-proto")).toBe(false);
  });
});
