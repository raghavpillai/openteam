import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CredentialProviderConnection } from "@openteam/contracts/saved-logins";
export type { CredentialProviderConnection } from "@openteam/contracts/saved-logins";
export const credentialConnectionId = (provider: CredentialProviderConnection) => `1password:${provider.account}:${provider.vault}`;
export const credentialConnections = (settings: CapabilitySettings): CredentialProviderConnection[] => settings.credentialProviders;
export interface CapabilitySettings {
  credentialProviders: CredentialProviderConnection[];
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
        revocationEpoch: value.revocationEpoch ?? 0,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Native capability settings could not be read");
      return { credentialProviders: [] };
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
    revoke?: "credentials";
    removeCredentialConnection?: string;
  }) {
    if (Object.keys(input).some(key => !["revoke", "removeCredentialConnection"].includes(key))) throw new Error("Unknown credential setting");
    if (input.revoke !== undefined && input.revoke !== "credentials") throw new Error("Invalid credential setting");
    return this.mutate((current) => {
      current.revocationEpoch = (current.revocationEpoch ?? 0) + 1;
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
