import { expect, test } from "bun:test";
import { pluginAuthorization, pluginNeedsSetup } from "../src/plugin-authorization";

test("OAuth handoff distinguishes waiting, expired, settled and unsafe destinations", () => {
  const connection = {
    status: "needs_auth",
    authorizationUrl: "https://provider.example/authorize?state=fixture",
    authorizationExpiresAt: new Date(2000).toISOString(),
  };
  expect(pluginAuthorization(connection, 1000)).toEqual({
    url: connection.authorizationUrl,
    state: "fixture",
    expired: false,
  });
  expect(pluginAuthorization(connection, 2000)?.expired).toBe(true);
  expect(pluginAuthorization({ ...connection, status: "ready" })).toBeNull();
  expect(
    pluginAuthorization({ ...connection, authorizationUrl: "javascript:alert(1)?state=fixture" })
  ).toBeNull();
  expect(
    pluginAuthorization({ ...connection, authorizationUrl: "https://provider.example/no-state" })
  ).toBeNull();
});

test("first-time dynamic OAuth can authorize while manual clients and missing tokens need setup", () => {
  expect(
    pluginNeedsSetup({ auth: "oauth", configured: false }, { setup: null, setupFields: [] })
  ).toBe(false);
  expect(pluginNeedsSetup({ auth: "token", configured: false })).toBe(true);
  expect(pluginNeedsSetup({ auth: "token", configured: true })).toBe(false);
  expect(
    pluginNeedsSetup(
      { auth: "oauth", configured: false },
      { setup: { kind: "oauth_client" } as any, setupFields: [] }
    )
  ).toBe(true);
});
