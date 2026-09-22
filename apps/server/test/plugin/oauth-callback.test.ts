import { expect, test } from "bun:test";
import {
  MANUAL_OAUTH_REDIRECT,
  oauthCallbackMode,
  parseManualCallback,
} from "../../src/plugins/oauth-callback";
import {
  connectionConfigured,
  connectionSetupPhase,
  connectionCallbackMode,
} from "../../src/services/plugin/values";
import { pluginCatalog } from "@openteam/plugins";

test("automatic callback follows the deployment URL and preserves explicit settings", () => {
  expect(oauthCallbackMode("https://bot.tail123.ts.net", {})).toBe("server");
  expect(oauthCallbackMode("http://100.100.10.5:8787", {})).toBe("manual");
  for (const mode of ["server", "manual", "desktop"] as const)
    expect(oauthCallbackMode("https://bot.example.com", { oauthCallbackMode: mode })).toBe(mode);
  expect(
    connectionCallbackMode("https://bot.test", {
      configuration: {},
      credentials: {
        oauth: { authorizationUrl: "https://provider.test?state=x", callbackMode: "manual" },
      },
    })
  ).toBe("manual");
  expect(
    connectionCallbackMode("http://bot.test", {
      configuration: {},
      credentials: { oauth: { authorizationUrl: "https://provider.test?state=x" } },
    })
  ).toBe("server");
});

test("manual callback parses success/denial and rejects malformed or ambiguous responses", () => {
  const parse = (value: string) => parseManualCallback(value, MANUAL_OAUTH_REDIRECT);
  expect(parse(`  ${MANUAL_OAUTH_REDIRECT}?state=s%2B1&code=c%2B2  `)).toMatchObject({
    state: "s+1",
    code: "c+2",
  });
  expect(parse(`${MANUAL_OAUTH_REDIRECT}?state=s&error=access_denied`)).toMatchObject({
    error: "access_denied",
  });
  for (const url of [
    "not a URL",
    "https://attacker.test/callback?state=s&code=c",
    "http://127.0.0.1:42814/callback?state=s&code=c",
    "http://user@127.0.0.1:42813/callback?state=s&code=c",
    `${MANUAL_OAUTH_REDIRECT}/other?state=s&code=c`,
    ...[
      "code=c",
      "state=s",
      "state=s&code=c&error=denied",
      "state=s&code=c&state=t",
      "state=s&code=c&code=d",
      "state=s&code=c#fragment",
      "state=s&code=c&iss=a&iss=b",
      `state=${"s".repeat(4097)}&code=c`,
    ].map((query) => `${MANUAL_OAUTH_REDIRECT}?${query}`),
  ])
    expect(() => parse(url)).toThrow("complete callback URL");
});

test("Safari address-bar copies may omit only the expected callback's scheme", () => {
  const parse = (value: string) => parseManualCallback(value, MANUAL_OAUTH_REDIRECT);
  const address = MANUAL_OAUTH_REDIRECT.replace(/^http:\/\//, "");
  const query = "state=s%2B1&iss=https%3A%2F%2Faccounts.google.com&code=c%2B2&scope=https://www.googleapis.com/auth/calendar.events";
  expect(parse(` ${address}?${query} `)).toEqual(parse(`${MANUAL_OAUTH_REDIRECT}?${query}`));
  expect(parse(`${address}?state=s&error=access_denied`).error).toBe("access_denied");
  for (const value of [
    `127.0.0.1:42814/callback?${query}`,
    `127.0.0.1:42813/callback/other?${query}`,
    `127.0.0.1:42813/callback.evil?${query}`,
    `127.0.0.1:42813@attacker.test/callback?${query}`,
    `user@${address}?${query}`,
    `//${address}?${query}`,
    `${address}?${query}#fragment`,
    `${address}?${query}&code=duplicate`,
    `${address}?${query}&state=duplicate`,
    `${address}?${query}&iss=duplicate`,
  ]) expect(() => parse(value)).toThrow("complete callback URL");
});

test("provider setup requires all fields, while dynamic registration needs no user-created app", () => {
  const gmail = pluginCatalog.find((row) => row.key === "gmail")!;
  const connection = {
    connectorKey: "gmail",
    authType: "oauth",
    status: "disconnected",
    configuration: {},
    credentials: {},
  };
  expect(connectionSetupPhase(connection, gmail)).toBe("provider_setup_required");
  const partial = { ...connection, configuration: { clientId: "client" } };
  expect(connectionConfigured(partial, gmail)).toBe(false);
  const configured = { ...partial, credentials: { clientSecret: "secret" } };
  expect(connectionSetupPhase(configured, gmail)).toBe("ready_to_authorize");
  expect(connectionSetupPhase({ ...configured, status: "error" }, gmail)).toBe("validation_failed");
  expect(connectionSetupPhase({ ...configured, status: "ready" }, gmail)).toBe("connected");
  const linear = pluginCatalog.find((row) => row.key === "linear")!;
  expect(connectionSetupPhase({ ...connection, connectorKey: "linear" }, linear)).toBe(
    "ready_to_authorize"
  );
  expect(connectionSetupPhase({ ...connection, authType: "none" })).toBe("ready_to_connect");
});
