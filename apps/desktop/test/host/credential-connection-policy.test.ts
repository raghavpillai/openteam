import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilitySettingsStore } from "../../src/main/host/capability-settings";
import {
  OnePasswordProvisioning,
  brokerCredentialCommand,
} from "../../src/main/host/onepassword-provisioning";
import { SavedCredentials } from "../../src/main/host/credentials";

test("connection permission sync, matching rules, ambiguous logins and revocation stay private", async () => {
  const root = await mkdtemp(join(tmpdir(), "connection-permission-"));
  try {
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    const connection = {
      id: "1password:account:vault",
      accountId: "account",
      vaultId: "vault",
      vaultName: "Fixture",
      generation: 1,
      permissionRevision: 0,
      alwaysAllow: false,
    };
    let reads = 0,
      duplicate = false,
      duringRead: (() => void) | undefined;
    const overview = {
      id: "login",
      title: "Fixture",
      category: "LOGIN",
      updated_at: "1",
      urls: [{ href: "https://example.com", autofillBehavior: "AnywhereOnWebsite" }],
    };
    const backend = async (operation: string, input?: any): Promise<any> => {
      if (operation === "always-allow") {
        connection.alwaysAllow = input.alwaysAllow;
        connection.permissionRevision++;
      }
      if (operation !== "operation") return [connection];
      if (input.operation !== "get")
        return [overview, ...(duplicate ? [{ ...overview, id: "other" }] : [])];
      reads++;
      duringRead?.();
      return {
        ...overview,
        fields: [{ purpose: "PASSWORD", value: "SYNTHETIC-PRIVATE-PASSWORD" }],
      };
    };
    const provisioning = new OnePasswordProvisioning(settings, backend, async () => {
      throw Error("Never invoke a local CLI");
    });
    await provisioning.refresh();
    const credentials = new SavedCredentials(
      settings,
      async () => "deny",
      brokerCredentialCommand(settings, backend)
    );
    expect(await credentials.automatic("https://login.example.com")).toEqual({ skipped: true });
    expect(reads).toBe(0);
    await provisioning.setAlwaysAllow(connection.id, true);
    expect((await credentials.automatic("https://login.example.com")) as any).toMatchObject({
      password: "SYNTHETIC-PRIVATE-PASSWORD",
    });
    expect(await credentials.automatic("https://example.com:8443")).toEqual({ skipped: true });
    expect(await credentials.automatic("https://unrelated.test")).toEqual({ skipped: true });
    duplicate = true;
    expect(await credentials.automatic("https://example.com")).toEqual({ skipped: true });
    duplicate = false;
    // Old per-item grants must also be revoked when a different desktop changes permission.
    await settings.mutate((value) => ({ ...value, autoFill: [connection.id + ":login"] }));
    // A second desktop changes the server-side grant during a private retrieval.
    duringRead = () => {
      connection.alwaysAllow = false;
      connection.permissionRevision++;
    };
    await expect(credentials.automatic("https://example.com")).rejects.toThrow(
      "revoked during retrieval"
    );
    expect((await settings.read()).credentialProvider?.alwaysAllow).toBe(false);
    expect((await settings.read()).autoFill).toEqual([]);
    expect(await credentials.automatic("https://example.com")).toEqual({ skipped: true });
    expect(JSON.stringify(await credentials.list({ site: "https://example.com" }))).not.toContain(
      "SYNTHETIC-PRIVATE-PASSWORD"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
