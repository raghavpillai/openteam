import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
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
  callbackMode?: "desktop";
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
      software_version: "0.0.1",
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
    await this.update({ authorizationUrl: authorizationUrl.toString() });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier });
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
      await this.replace({
        state: this.value.state,
        stateCreatedAt: this.value.stateCreatedAt,
        stateGeneration: this.value.stateGeneration,
        redirectUrl: this.value.redirectUrl,
        callbackSessionId: this.value.callbackSessionId,
        callbackMode: this.value.callbackMode,
        exchangeStarted: this.value.exchangeStarted,
      });
      return;
    }
    if (scope === "client") await this.update({ clientInformation: undefined });
    if (scope === "tokens") await this.update({ tokens: undefined, tokensExpireAt: undefined });
    if (scope === "verifier") await this.update({ codeVerifier: undefined });
  }

  snapshot(): StoredOAuthState {
    return { ...this.value };
  }

  private async update(patch: Partial<StoredOAuthState>): Promise<void> {
    const next = { ...this.value };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (next as Record<string, unknown>)[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    await this.replace(next);
  }

  private async replace(value: StoredOAuthState): Promise<void> {
    this.value = value;
    await this.options.save(value);
  }
}
