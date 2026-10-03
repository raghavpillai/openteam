import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CredentialProviderConnection } from "@openteam/contracts/saved-logins";
export type { CredentialProviderConnection } from "@openteam/contracts/saved-logins";
export const credentialConnectionId = (provider: CredentialProviderConnection) => `1password:${provider.account}:${provider.vault}`;
export const credentialConnections = (settings: CapabilitySettings): CredentialProviderConnection[] => settings.credentialProviders;
export interface CapabilitySettings {
  credentialProviders: CredentialProviderConnection[];
  messagesSendAll?: boolean;
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
        credentialProviders: value.credentialProviders ?? [],
        messagesSendAll: value.messagesSendAll === true,
        cookieGrants: value.cookieGrants ?? [],
        messagesGrants: value.messagesGrants ?? [],
        revocationEpoch: value.revocationEpoch ?? 0,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Native capability settings could not be read");
      return { credentialProviders: [], cookieGrants: [], messagesGrants: [] };
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
    revoke?: "cookies" | "credentials" | "messages";
    removeCredentialConnection?: string;
    messagesSendAll?: boolean;
  }) {
    if (Object.keys(input).some(key => !["revoke", "removeCredentialConnection", "messagesSendAll"].includes(key)))
      throw new Error("Unknown native capability setting");
    return this.mutate((current) => {
      current.revocationEpoch = (current.revocationEpoch ?? 0) + 1;
      if (input.revoke === "cookies") current.cookieGrants = [];
      if (input.revoke === "messages") {current.messagesGrants = []; current.messagesSendAll = false;}
      if (input.messagesSendAll !== undefined) { if(typeof input.messagesSendAll !== "boolean") throw new Error("Invalid Messages send setting"); current.messagesSendAll = input.messagesSendAll; }
      if (input.revoke === "credentials") {
        current.credentialProviders = [];
      }
      if (input.removeCredentialConnection !== undefined) {
        if(typeof input.removeCredentialConnection !== "string") throw new Error("Invalid credential connection");
        current.credentialProviders = credentialConnections(current).filter(provider => credentialConnectionId(provider) !== input.removeCredentialConnection);
      }
      return current;
    });
  }
}
export type NativeConsent = (input: {
  title: string;
  detail: string;
  allowAlways?: boolean;
  selectItems?: (items: readonly string[]) => void;
  presentation?: { kind: "saved-login"; title: string; site: string; category: string; purpose: string } | { kind: "cookie-import"; items: Array<{ origin: string; profileId: string; profileDisplayName: string }> };
}) => Promise<"once" | "always" | "deny">;
