import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export interface CredentialProviderConnection { account: string; vault: string }
export const credentialConnectionId = (provider: CredentialProviderConnection) => `1password:${provider.account}:${provider.vault}`;
export const credentialConnections = (settings: CapabilitySettings): CredentialProviderConnection[] => settings.credentialProviders ?? (settings.credentialProvider ? [settings.credentialProvider] : []);
export interface CapabilitySettings {
  credentialProvider: { account: string; vault: string } | null;
  credentialProviders?: CredentialProviderConnection[];
  messagesSendAll?: boolean;
  autoFill: string[];
  cookieGrants: string[];
  messagesGrants: string[];
  revocationEpoch?: number;
}
export class CapabilitySettingsStore {
  private tail = Promise.resolve();
  constructor(private readonly path: string) {}
  async read(): Promise<CapabilitySettings> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return {
        credentialProvider: value.credentialProviders?.[0] ?? value.credentialProvider ?? null,
        credentialProviders: value.credentialProviders ?? (value.credentialProvider ? [value.credentialProvider] : []),
        messagesSendAll: value.messagesSendAll === true,
        autoFill: value.autoFill ?? [],
        cookieGrants: value.cookieGrants ?? [],
        messagesGrants: value.messagesGrants ?? [],
        revocationEpoch: value.revocationEpoch ?? 0,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Native capability settings could not be read");
      return { credentialProvider: null, autoFill: [], cookieGrants: [], messagesGrants: [] };
    }
  }
  mutate(
    operation: (current: CapabilitySettings) => CapabilitySettings
  ): Promise<CapabilitySettings> {
    const result = this.tail.then(async () => {
      const next = operation(await this.read());
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.path);
      return next;
    });
    this.tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
  update(input: {
    account?: string;
    vault?: string;
    revoke?: "cookies" | "credentials" | "messages";
    autoFill?: string[];
    removeCredentialConnection?: string;
    messagesSendAll?: boolean;
  }) {
    return this.mutate((current) => {
      current.revocationEpoch = (current.revocationEpoch ?? 0) + 1;
      if (input.revoke === "cookies") current.cookieGrants = [];
      if (input.revoke === "messages") {current.messagesGrants = []; current.messagesSendAll = false;}
      if (input.messagesSendAll !== undefined) { if(typeof input.messagesSendAll !== "boolean") throw new Error("Invalid Messages send setting"); current.messagesSendAll = input.messagesSendAll; }
      if (input.revoke === "credentials") {
        current.credentialProvider = null;
        current.credentialProviders = [];
        current.autoFill = [];
      }
      if (input.account !== undefined || input.vault !== undefined) {
        if (
          typeof input.account !== "string" ||
          !input.account.trim() ||
          input.account.length > 256 ||
          typeof input.vault !== "string" ||
          !input.vault.trim() ||
          input.vault.length > 256
        )
          throw new Error("Specify a 1Password account and vault ID");
        const provider = { account: input.account.trim(), vault: input.vault.trim() };
        const connections = credentialConnections(current).filter(existing => credentialConnectionId(existing) !== credentialConnectionId(provider));
        current.credentialProviders = [...connections, provider];
        current.credentialProvider = current.credentialProviders[0] ?? null;
      }
      if (input.removeCredentialConnection !== undefined) {
        if(typeof input.removeCredentialConnection !== "string") throw new Error("Invalid credential connection");
        current.credentialProviders = credentialConnections(current).filter(provider => credentialConnectionId(provider) !== input.removeCredentialConnection);
        current.credentialProvider = current.credentialProviders[0] ?? null;
        current.autoFill = current.autoFill.filter(key => !key.startsWith(input.removeCredentialConnection + ":"));
      }
      if (input.autoFill !== undefined) {
        if (
          !Array.isArray(input.autoFill) ||
          input.autoFill.length > 100 ||
          input.autoFill.some((x) => typeof x !== "string" || x.length > 512)
        )
          throw new Error("Invalid auto-fill selection");
        current.autoFill = [...new Set(input.autoFill)];
      }
      return current;
    });
  }
}
export type NativeConsent = (input: {
  title: string;
  detail: string;
  allowAlways?: boolean;
}) => Promise<"once" | "always" | "deny">;
