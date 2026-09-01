import { describe, expect, test } from "bun:test";
import { normalizeServerConnection } from "../src/server-config-core";

describe("mobile server configuration", () => {
  test("normalizes an HTTPS endpoint", () => {
    expect(
      normalizeServerConnection({
        serverUrl: " https://openbot.example.test/// ",
      })
    ).toEqual({ serverUrl: "https://openbot.example.test" });
  });

  test("rejects non-network URLs", () => {
    expect(() => normalizeServerConnection({ serverUrl: "file:///tmp/openbot" })).toThrow(
      "HTTP or HTTPS"
    );
  });

  test("supports a reachable HTTP endpoint for local self-hosting", () => {
    expect(
      normalizeServerConnection({
        serverUrl: " http://192.168.1.42:4040/ ",
      })
    ).toEqual({ serverUrl: "http://192.168.1.42:4040" });
  });

  test("preserves a reverse-proxy path", () => {
    expect(
      normalizeServerConnection({
        serverUrl: "https://example.test/openbot/",
      })
    ).toEqual({ serverUrl: "https://example.test/openbot" });
  });

  test("rejects credentials, queries, and fragments in an endpoint", () => {
    expect(() =>
      normalizeServerConnection({ serverUrl: "https://owner:secret@example.test" })
    ).toThrow("without a username or password");
    expect(() =>
      normalizeServerConnection({ serverUrl: "https://example.test?tenant=openbot" })
    ).toThrow("without a query or fragment");
    expect(() => normalizeServerConnection({ serverUrl: "https://example.test#openbot" })).toThrow(
      "without a query or fragment"
    );
  });
});
