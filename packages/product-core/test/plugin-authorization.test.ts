import { expect, test } from "bun:test";
import { pluginAuthorization } from "../src/plugin-authorization";

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
