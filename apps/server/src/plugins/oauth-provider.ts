import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface StoredOAuthState {
  state?: string;
  authorizationUrl?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

export interface OAuthProviderOptions {
  redirectUrl: string;
  scope?: string;
  initial: StoredOAuthState;
  clientInformation?: OAuthClientInformationMixed;
  save: (state: StoredOAuthState) => Promise<void>;
}

/** Persists the SDK's OAuth session in the owning PluginConnection record. */
export class OpenBotOAuthProvider implements OAuthClientProvider {
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
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "OpenBot",
      scope: this.options.scope,
      software_id: "openbot",
      software_version: "0.1.0",
    };
  }

  state(): string {
    return this.value.state ?? "";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.value.clientInformation ?? this.options.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update({ clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.value.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({ tokens, authorizationUrl: undefined });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.update({ authorizationUrl: authorizationUrl.toString() });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier });
  }

  codeVerifier(): string {
    if (!this.value.codeVerifier) throw new Error("OAuth code verifier is missing");
    return this.value.codeVerifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "all") {
      await this.replace({ state: this.value.state });
      return;
    }
    if (scope === "client") await this.update({ clientInformation: undefined });
    if (scope === "tokens") await this.update({ tokens: undefined });
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
