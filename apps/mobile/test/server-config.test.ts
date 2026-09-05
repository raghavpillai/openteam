import { describe, expect, test } from "bun:test";
import { normalizeServerConnection } from "../src/server-config-core";

describe("mobile server configuration", () => {
  test("normalizes an HTTPS endpoint", () => {
    expect(
      normalizeServerConnection({
        serverUrl: " https://openteam.example.test/// ",
      })
    ).toEqual({ serverUrl: "https://openteam.example.test" });
  });

  test("rejects non-network URLs", () => {
    expect(() => normalizeServerConnection({ serverUrl: "file:///tmp/openteam" })).toThrow(
      "HTTP or HTTPS"
    );
  });

  test("supports a raw HTTP endpoint using a Tailscale IPv4 address", () => {
    expect(
      normalizeServerConnection({
        serverUrl: " http://100.94.42.50:8787/ ",
      })
    ).toEqual({ serverUrl: "http://100.94.42.50:8787" });
  });

  test("supports raw HTTP endpoints using public IPv4 and IPv6 addresses", () => {
    expect(normalizeServerConnection({ serverUrl: "http://203.0.113.7:8787/" })).toEqual({
      serverUrl: "http://203.0.113.7:8787",
    });
    expect(normalizeServerConnection({ serverUrl: "http://[2001:db8::7]:8787/" })).toEqual({
      serverUrl: "http://[2001:db8::7]:8787",
    });
  });

  test("preserves a reverse-proxy path", () => {
    expect(
      normalizeServerConnection({
        serverUrl: "https://example.test/openteam/",
      })
    ).toEqual({ serverUrl: "https://example.test/openteam" });
  });

  test("rejects credentials, queries, and fragments in an endpoint", () => {
    expect(() =>
      normalizeServerConnection({ serverUrl: "https://owner:secret@example.test" })
    ).toThrow("without a username or password");
    expect(() =>
      normalizeServerConnection({ serverUrl: "https://example.test?tenant=openteam" })
    ).toThrow("without a query or fragment");
    expect(() => normalizeServerConnection({ serverUrl: "https://example.test#openteam" })).toThrow(
      "without a query or fragment"
    );
  });
});
