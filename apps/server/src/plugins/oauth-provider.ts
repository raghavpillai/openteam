import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ApiError } from "@openteam/contracts";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface StoredOAuthState {
  state?: string;
  stateCreatedAt?: number;
  stateGeneration?: number;
  authorizationUrl?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokensExpireAt?: number;
  redirectUrl?: string;
  callbackSessionId?: string | null;
  callbackMode?: "desktop" | "manual";
  exchangeStarted?: boolean;
  issuer?: string;
}

export interface OAuthProviderOptions {
  redirectUrl: string;
  scope?: string;
  initial: StoredOAuthState;
  clientInformation?: OAuthClientInformationMixed;
  save: (state: StoredOAuthState) => Promise<void>;
  tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
  authorizationParameters?: Record<string, string>;
}

/** Persists the SDK's OAuth session in the owning PluginConnection record. */
export class OpenTeamOAuthProvider implements OAuthClientProvider {
  private value: StoredOAuthState;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: OAuthProviderOptions) {
    this.value = { ...options.initial };
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.options.redirectUrl],
      token_endpoint_auth_method:
        this.options.tokenEndpointAuthMethod ??
        (this.options.clientInformation?.client_secret ? "client_secret_post" : "none"),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "OpenTeam",
      scope: this.options.scope,
      software_id: "openteam",
      software_version: "0.0.0",
    };
  }

  state(): string {
    return this.value.state ?? "";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.options.clientInformation ?? this.value.clientInformation;
    return client
      ? {
          ...client,
          token_endpoint_auth_method:
            this.options.tokenEndpointAuthMethod ??
            ("token_endpoint_auth_method" in client &&
            typeof client.token_endpoint_auth_method === "string"
              ? client.token_endpoint_auth_method
              : this.clientMetadata.token_endpoint_auth_method),
        }
      : undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update({ clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.value.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({
      tokens,
      tokensExpireAt:
        tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1_000,
      authorizationUrl: undefined,
      state: undefined,
      stateCreatedAt: undefined,
      stateGeneration: undefined,
      codeVerifier: undefined,
      callbackSessionId: undefined,
      callbackMode: undefined,
      exchangeStarted: undefined,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Discovery can advertise a superset of the permissions this connection uses.
    if (this.options.scope) authorizationUrl.searchParams.set("scope", this.options.scope);
    // Provider extensions must never replace state, PKCE, client ID, or callback URL.
    for (const key of ["access_type", "prompt"]) {
      const value = this.options.authorizationParameters?.[key];
      if (value) authorizationUrl.searchParams.set(key, value);
    }
    await this.update({ authorizationUrl: authorizationUrl.toString() }, () => this.assertInteractiveAuthorization());
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier }, () => this.assertInteractiveAuthorization());
  }

  private assertInteractiveAuthorization(): void {
    // Only the user's explicit sign-in action creates a callback/state session.
    // A background SDK retry must not start a browser flow with an empty state.
    if (!this.value.state) {
      // The SDK falls through to interactive authorization on a temporary
      // refresh failure too. Keep the existing grant so a later call can retry.
      if (this.value.tokens?.refresh_token)
        throw new ApiError(503, "plugin_token_refresh_failed", "Authorization could not be refreshed. Try again shortly.");
      throw new UnauthorizedError("Sign in to this account again.");
    }
  }

  codeVerifier(): string {
    if (!this.value.codeVerifier) throw new Error("OAuth code verifier is missing");
    return this.value.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.saveIssuer(state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl);
  }

  async saveIssuer(issuer: string): Promise<void> {
    await this.update({ issuer });
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "all") {
      await this.enqueue(() => this.replace({
        state: this.value.state,
        stateCreatedAt: this.value.stateCreatedAt,
        stateGeneration: this.value.stateGeneration,
        redirectUrl: this.value.redirectUrl,
        callbackSessionId: this.value.callbackSessionId,
        callbackMode: this.value.callbackMode,
        exchangeStarted: this.value.exchangeStarted,
      }));
      return;
    }
    if (scope === "client") await this.update({ clientInformation: undefined });
    if (scope === "tokens") await this.update({ tokens: undefined, tokensExpireAt: undefined });
    if (scope === "verifier") await this.update({ codeVerifier: undefined });
  }

  snapshot(): StoredOAuthState {
    return { ...this.value };
  }

  private async update(patch: Partial<StoredOAuthState>, validate?: () => void): Promise<void> {
    await this.enqueue(async () => {
      validate?.();
      const next = { ...this.value };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (next as Record<string, unknown>)[key];
        else (next as Record<string, unknown>)[key] = value;
      }
      await this.replace(next);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.writes.then(operation);
    // A rejected save must not prevent later valid writes from running.
    this.writes = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async replace(value: StoredOAuthState): Promise<void> {
    try {
      await this.options.save(value);
    } catch (error) {
      // Failed writes can include the new token/verifier in diagnostics, before
      // that secret exists in storage. Never let those diagnostics reach UI/logs.
      if (error instanceof ApiError && error.code === "plugin_oauth_session_changed")
        throw new ApiError(409, error.code, "A newer authorization attempt or configuration change replaced this session");
      throw new ApiError(503, "plugin_oauth_persistence_failed", "Could not save sign-in state. Start sign-in again.");
    }
    this.value = value;
  }
}
