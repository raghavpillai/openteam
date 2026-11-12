import { gate } from "./fixtures/gate";
import { expect, test } from "bun:test";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OpenTeamOAuthProvider, type StoredOAuthState } from "../../src/plugins/oauth-provider";
import { PluginTransport } from "../../src/services/plugin/transport";

test("OAuth redirects preserve configured scopes and protected parameters while requesting offline access", async () => {
  let stored: StoredOAuthState = {};
  const provider = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1/callback",
    scope: "mail.read mail.compose",
    initial: { state: "original" },
    authorizationParameters: {
      access_type: "offline",
      prompt: "consent select_account",
      state: "wrong",
      redirect_uri: "https://wrong.example",
      code_challenge: "wrong",
    },
    save: async (value) => {
      stored = value;
    },
  });
  const url = new URL(
    "https://accounts.example/authorize?scope=mail.delete&state=original&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&code_challenge=pkce"
  );
  await provider.redirectToAuthorization(url);
  const saved = new URL(stored.authorizationUrl!);
  expect(saved.searchParams.get("scope")).toBe("mail.read mail.compose");
  expect(saved.searchParams.get("access_type")).toBe("offline");
  expect(saved.searchParams.get("prompt")).toBe("consent select_account");
  expect(saved.searchParams.get("state")).toBe("original");
  expect(saved.searchParams.get("redirect_uri")).toBe("http://127.0.0.1/callback");
  expect(saved.searchParams.get("code_challenge")).toBe("pkce");
});

test("OAuth provider persists state, dynamic registration, verifier, redirect, and tokens", async () => {
  let stored: StoredOAuthState = { state: "expected-state" };
  const provider = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1:8787/api/v0/plugin-oauth/callback?connectionId=test",
    scope: "mail.read",
    initial: stored,
    save: async (state) => {
      stored = state;
    },
  });
  expect(provider.state()).toBe("expected-state");
  expect(provider.clientMetadata.scope).toBe("mail.read");
  await provider.saveClientInformation({ client_id: "registered-client" });
  await provider.saveCodeVerifier("verifier");
  await provider.redirectToAuthorization(new URL("https://accounts.example/authorize"));
  const tokens: OAuthTokens = {
    access_token: "access",
    refresh_token: "refresh",
    token_type: "Bearer",
  };
  await provider.saveTokens(tokens);
  expect(stored.clientInformation).toMatchObject({ client_id: "registered-client" });
  expect(stored.codeVerifier).toBeUndefined();
  expect(stored.state).toBeUndefined();
  expect(stored.authorizationUrl).toBeUndefined();
  expect(provider.tokens()).toEqual(tokens);
});

test("dynamic remote OAuth does not inherit another provider's global client identity", () => {
  const originalId = process.env.OPENTEAM_MCP_OAUTH_CLIENT_ID;
  const originalSecret = process.env.OPENTEAM_MCP_OAUTH_CLIENT_SECRET;
  try {
    process.env.OPENTEAM_MCP_OAUTH_CLIENT_ID = "unrelated-client";
    process.env.OPENTEAM_MCP_OAUTH_CLIENT_SECRET = "unrelated-secret";
    const transport = new PluginTransport({} as any, {} as any, "http://localhost:8787");
    const options = transport.httpOptions({id:"test",connectorKey:"t3-code",endpoint:"https://t3.example/mcp",authType:"oauth",configuration:{oauthRegistration:"dynamic"},credentials:{}});
    expect(options.authProvider?.clientInformation()).toBeUndefined();
    expect(options.authProvider?.clientMetadata.token_endpoint_auth_method).toBe("none");
  } finally {
    if (originalId === undefined) delete process.env.OPENTEAM_MCP_OAUTH_CLIENT_ID; else process.env.OPENTEAM_MCP_OAUTH_CLIENT_ID = originalId;
    if (originalSecret === undefined) delete process.env.OPENTEAM_MCP_OAUTH_CLIENT_SECRET; else process.env.OPENTEAM_MCP_OAUTH_CLIENT_SECRET = originalSecret;
  }
});

test("failed credential persistence cannot change the provider's in-memory authorization", async () => {
  const original = { access_token: "original-synthetic-token", token_type: "Bearer" };
  let fail = true;
  let stored: StoredOAuthState = { tokens: original };
  const provider = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1/callback", initial: stored,
    save: async state => { if (fail) throw new Error("Injected database failure"); stored = state; },
  });
  await expect(provider.saveTokens({ access_token: "uncommitted-synthetic-token", token_type: "Bearer" })).rejects.toThrow("Could not save sign-in state");
  expect(provider.tokens()).toEqual(original);
  fail = false;
  await provider.saveIssuer("https://issuer.example");
  expect(stored.tokens).toEqual(original);
});

test("concurrent OAuth metadata saves retain both updates", async () => {
  let stored: StoredOAuthState = {};
  const provider = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1/callback", initial: {}, save: async state => { stored = state; },
  });
  await Promise.all([provider.saveIssuer("https://issuer.example"), provider.saveClientInformation({ client_id: "public-client" })]);
  expect(stored.issuer).toBe("https://issuer.example");
  expect(stored.clientInformation?.client_id).toBe("public-client");
  expect(provider.snapshot()).toEqual(stored);
});

test("a delayed metadata save cannot restore an older access token", async () => {
  const entered = gate(), release = gate();
  let stored: StoredOAuthState = { tokens: { access_token: "old-token", token_type: "Bearer" } };
  const provider = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1/callback", initial: stored, save: async state => {
      if (state.issuer && state.tokens?.access_token === "old-token") { entered.release(); await release.promise; }
      stored = state;
    },
  });
  const metadata = provider.saveIssuer("https://issuer.example");
  try {
    await entered.promise;
    const tokens = provider.saveTokens({ access_token: "new-token", token_type: "Bearer" });
    release.release();
    await Promise.all([metadata, tokens]);
    expect(stored.tokens?.access_token).toBe("new-token");
    expect(stored.issuer).toBe("https://issuer.example");
    expect(provider.tokens()).toEqual(stored.tokens);
  } finally { release.release(); await metadata; }
});

for (const operation of ["verifier", "redirect"] as const) {
  test(`a stale ${operation} cannot reopen sign-in behind a successful token write`, async () => {
    const entered = gate(), release = gate();
    let stored: StoredOAuthState = { state: "pending-sign-in" };
    const provider = new OpenTeamOAuthProvider({
      redirectUrl: "http://127.0.0.1/callback", initial: stored, save: async state => {
        if (state.tokens) { entered.release(); await release.promise; }
        stored = state;
      },
    });
    const tokens = provider.saveTokens({ access_token: "new-token", token_type: "Bearer" });
    try {
      await entered.promise;
      const pending = (operation === "verifier" ? provider.saveCodeVerifier("stale-verifier")
        : provider.redirectToAuthorization(new URL("https://issuer.example/authorize?state=pending-sign-in")))
        .then(() => "saved", () => "rejected");
      release.release();
      await tokens;
      expect(await pending).toBe("rejected");
      expect(stored.tokens?.access_token).toBe("new-token");
      expect(stored.authorizationUrl).toBeUndefined();
      expect(stored.codeVerifier).toBeUndefined();
    } finally { release.release(); await tokens; }
  });
}

test("a failed queued write cannot poison later OAuth saves", async () => {
  let stored: StoredOAuthState = {};
  let first = true;
  const provider = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1/callback", initial: {}, save: async state => {
      if (first) { first = false; throw new Error("Synthetic persistence failure"); }
      stored = state;
    },
  });
  const results = await Promise.allSettled([provider.saveIssuer("https://issuer.example"), provider.saveClientInformation({ client_id: "next-client" })]);
  expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
  expect(stored.clientInformation?.client_id).toBe("next-client");
  expect(stored.issuer).toBeUndefined();
});

for (const scope of ["all", "tokens", "client", "verifier"] as const) {
  test(`queued ${scope} invalidation cannot be undone by an older metadata write`, async () => {
    const entered = gate(), release = gate();
    let stored: StoredOAuthState = {
      state: "pending-sign-in", codeVerifier: "old-verifier",
      clientInformation: { client_id: "old-client" }, tokens: { access_token: "old-token", token_type: "Bearer" },
    };
    const provider = new OpenTeamOAuthProvider({
      redirectUrl: "http://127.0.0.1/callback", initial: stored, save: async state => {
        if (state.issuer && state.tokens?.access_token === "old-token") { entered.release(); await release.promise; }
        stored = state;
      },
    });
    const metadata = provider.saveIssuer("https://issuer.example");
    try {
      await entered.promise;
      const invalidated = provider.invalidateCredentials(scope);
      release.release();
      await Promise.all([metadata, invalidated]);
      if (scope === "all" || scope === "tokens") expect(stored.tokens).toBeUndefined();
      if (scope === "all" || scope === "client") expect(stored.clientInformation).toBeUndefined();
      if (scope === "all" || scope === "verifier") expect(stored.codeVerifier).toBeUndefined();
      expect(provider.snapshot()).toEqual(stored);
    } finally { release.release(); await metadata; }
  });
}
