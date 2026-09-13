import {
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { PluginConnectorDefinition } from "@openteam/plugin-sdk";
import { OpenTeamOAuthProvider } from "./oauth-provider";

type PackagedOAuth = NonNullable<PluginConnectorDefinition["oauth"]>;
const metadata = (oauth: PackagedOAuth, provider: OpenTeamOAuthProvider) => {
  if (!oauth.authorizationServer) throw new Error("Packaged OAuth server is missing");
  return {
    issuer: oauth.authorizationServer.issuer,
    authorization_endpoint: oauth.authorizationServer.authorizationUrl,
    token_endpoint: oauth.authorizationServer.tokenUrl,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      provider.clientMetadata.token_endpoint_auth_method ?? "none",
    ],
  };
};
const client = (provider: OpenTeamOAuthProvider) => {
  const value = provider.clientInformation();
  if (!value) throw new Error("Configure an OAuth client ID before authorizing this account");
  return value;
};
const fetchWithTimeout: FetchLike = (input, init) =>
  fetch(input, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });

export async function beginPackagedOAuth(provider: OpenTeamOAuthProvider, oauth: PackagedOAuth) {
  const server = metadata(oauth, provider);
  const result = await startAuthorization(server.issuer, {
    metadata: server,
    clientInformation: client(provider),
    redirectUrl: provider.redirectUrl,
    scope: provider.clientMetadata.scope,
    state: provider.state(),
  });
  await provider.saveCodeVerifier(result.codeVerifier);
  await provider.redirectToAuthorization(result.authorizationUrl);
  return { authorizationUrl: result.authorizationUrl.toString() };
}

export async function finishPackagedOAuth(
  provider: OpenTeamOAuthProvider,
  oauth: PackagedOAuth,
  code: string
) {
  const server = metadata(oauth, provider);
  await provider.saveTokens(
    await exchangeAuthorization(server.issuer, {
      metadata: server,
      clientInformation: client(provider),
      authorizationCode: code,
      codeVerifier: provider.codeVerifier(),
      redirectUri: provider.redirectUrl,
      fetchFn: fetchWithTimeout,
    })
  );
}

export async function packagedAccessToken(provider: OpenTeamOAuthProvider, oauth: PackagedOAuth) {
  const tokens = provider.tokens();
  if (!tokens) throw new Error("Authorize this account before connecting");
  const expiresAt = provider.snapshot().tokensExpireAt;
  if (expiresAt !== undefined && expiresAt > Date.now() + 60_000) return tokens.access_token;
  // Legacy sessions have no absolute expiry; refresh them once before use.
  if (!tokens.refresh_token) {
    if (expiresAt === undefined) return tokens.access_token;
    throw new Error("OAuth token expired. Authorize this account again.");
  }
  const server = metadata(oauth, provider);
  const refreshed = await refreshAuthorization(server.issuer, {
    metadata: server,
    clientInformation: client(provider),
    refreshToken: tokens.refresh_token,
    fetchFn: fetchWithTimeout,
  });
  await provider.saveTokens(refreshed);
  return refreshed.access_token;
}
