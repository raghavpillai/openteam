import { gate } from "./fixtures/gate";
import { expect, test } from "bun:test";
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
