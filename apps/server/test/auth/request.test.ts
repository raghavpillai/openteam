import { expect, test } from "bun:test";
import { authRequestWithClientIp, loginOriginAllowed } from "../../src/auth-request";

const proxySecret = "openteam-test-proxy-secret-that-is-at-least-32-characters";
const peer = (address: string) => ({ requestIP: () => ({ address }) });

test("client attribution ignores spoofed headers and trusts only Caddy's proof or a private forwarder's last hop", async () => {
  const direct = new Request("http://openteam.test/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner" }), headers: {
    "content-type": "application/json", "x-forwarded-for": "198.51.100.8", "x-openteam-client-ip": "198.51.100.9", "x-openteam-proxy": "wrong-secret",
  } });
  const attributed = authRequestWithClientIp(direct, peer("203.0.113.7"), proxySecret, undefined, await direct.text());
  expect(attributed.headers.get("x-openteam-client-ip")).toBe("203.0.113.7");
  expect(attributed.headers.has("x-forwarded-for")).toBe(false);
  expect(attributed.headers.has("x-openteam-proxy")).toBe(false);

  const caddy = authRequestWithClientIp(new Request("http://server:8787/api/auth/config", { headers: {
    "x-forwarded-for": "198.51.100.8", "x-forwarded-proto": "https", "x-openteam-proxy": proxySecret,
  } }), peer("172.20.0.5"), proxySecret);
  expect(caddy.headers.get("x-openteam-client-ip")).toBe("198.51.100.8");
  expect(caddy.headers.has("x-forwarded-proto")).toBe(false);

  for (const [address, forwarded, expected] of [
    ["172.20.0.1", "198.51.100.42", "198.51.100.42"], ["172.20.0.1", "198.51.100.99, 198.51.100.42", "198.51.100.42"],
    ["::ffff:172.20.0.1", "2001:db8::42", "2001:db8::42"], ["fd00::1", "2001:db8::42", "2001:db8::42"], ["fe80::1", "2001:db8::42", "2001:db8::42"],
  ] as const) {
    const external = authRequestWithClientIp(new Request("http://server:8787/api/auth/config", { headers: { "x-forwarded-for": forwarded } }),
      peer(address), proxySecret, undefined, undefined, { trustPrivateForwarder: true });
    expect(external.headers.get("x-openteam-client-ip")).toBe(expected);
  }
});

test("gives native login requests the server origin without trusting a supplied origin", async () => {
  const login = (headers: Record<string, string> = {}, body = JSON.stringify({ username: "owner", password: "secret" })) =>
    new Request("https://team.example.test/api/auth/login", { method: "POST", headers, body });
  for (const suppliedOrigin of [undefined, "null"]) {
    const request = login({ "content-type": "application/json", cookie: "better-auth.session_token=stale.invalid", ...(suppliedOrigin ? { origin: suppliedOrigin } : {}) });
    const attributed = authRequestWithClientIp(request, peer("203.0.113.7"), proxySecret, new URL("/api/auth/sign-in/username", request.url),
      await request.text(), { fallbackOrigin: "https://team.example.test", stripCookies: true });
    expect(attributed.headers.get("origin")).toBe("https://team.example.test");
    expect(attributed.headers.has("cookie")).toBe(false);
  }
  const crossOrigin = login({ origin: "https://untrusted.example.test" }, "{}");
  const attributed = authRequestWithClientIp(crossOrigin, peer("203.0.113.7"), proxySecret, undefined, await crossOrigin.text(), { fallbackOrigin: "https://team.example.test" });
  expect(attributed.headers.get("origin")).toBe("https://untrusted.example.test");
  expect(loginOriginAllowed(crossOrigin, "https://team.example.test")).toBe(false);
  expect(loginOriginAllowed(new Request("https://team.example.test/api/auth/login", { headers: { origin: "https://team.example.test" } }), "https://team.example.test")).toBe(true);
  expect(loginOriginAllowed(new Request("https://team.example.test/api/auth/login"), "https://team.example.test")).toBe(true);
});
