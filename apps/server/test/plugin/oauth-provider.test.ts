import { expect, test } from "bun:test";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OpenTeamOAuthProvider, type StoredOAuthState } from "../../src/plugins/oauth-provider";

test("OAuth redirects preserve configured scopes and protected parameters while requesting offline access", async () => {
  let stored: StoredOAuthState = {};
  const provider = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1/callback",
    scope: "mail.read mail.compose",
    initial: {},
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
