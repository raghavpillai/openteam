import { describe, expect, test } from "bun:test";
import { normalizeServerConnection } from "../src/server-config-core";

describe("mobile server configuration", () => {
  test("normalizes an HTTPS endpoint and trims the secret", () => {
    expect(
      normalizeServerConnection({
        serverUrl: " https://openbot.example.test/// ",
        accessToken: " token-value ",
      })
    ).toEqual({ serverUrl: "https://openbot.example.test", accessToken: "token-value" });
  });

  test("rejects non-network URLs", () => {
    expect(() =>
      normalizeServerConnection({ serverUrl: "file:///tmp/openbot", accessToken: "" })
    ).toThrow("HTTP or HTTPS");
  });
});
