import { expect, test } from "bun:test";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OpenBotOAuthProvider, type StoredOAuthState } from "../src/plugins/oauth-provider";

test("OAuth provider persists state, dynamic registration, verifier, redirect, and tokens", async () => {
  let stored: StoredOAuthState = { state: "expected-state" };
  const provider = new OpenBotOAuthProvider({
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
  expect(stored.codeVerifier).toBe("verifier");
  expect(stored.authorizationUrl).toBeUndefined();
  expect(provider.tokens()).toEqual(tokens);
});
