import { describe, expect, test } from "bun:test";
import {
  authorizedApi,
  isLoopbackAddress,
  isLoopbackHostname,
  isTrustedLocalApiClient,
} from "../src/api-auth";

describe("remote API authentication", () => {
  test("requires the configured bearer token for remote clients", () => {
    expect(
      authorizedApi(
        new Request("http://openteam.test/api/v0/client-snapshot"),
        "secret",
        "10.0.0.4",
        true
      )
    ).toBe(false);
    expect(
      authorizedApi(
        new Request("http://openteam.test/api/v0/client-snapshot", {
          headers: { authorization: "Bearer secret" },
        }),
        "secret",
        "10.0.0.4",
        true
      )
    ).toBe(true);
  });

  test("keeps the desktop loopback connection working unless explicitly disabled", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("openteam.example.test")).toBe(false);
    expect(isTrustedLocalApiClient("172.18.0.1", "127.0.0.1", true)).toBe(true);
    expect(isTrustedLocalApiClient("172.18.0.1", "127.0.0.1", false)).toBe(false);
    const request = new Request("http://127.0.0.1/api/v0/client-snapshot");
    expect(authorizedApi(request, "secret", "127.0.0.1", true)).toBe(true);
    expect(authorizedApi(request, "secret", "127.0.0.1", false)).toBe(false);
  });
});
