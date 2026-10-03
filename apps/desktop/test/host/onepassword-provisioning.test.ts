import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnePasswordProvisioning, brokerCredentialCommand } from "../../src/main/host/onepassword-provisioning";
import { CapabilitySettingsStore } from "../../src/main/host/capability-settings";
const connection = { accountId: "service-account", vaultId: "vault", vaultName: "Shared with OpenTeam", generation: 1 };

test("manual import validates tokens, keeps metadata private and denies legacy local reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "manual-token-"));
  try {
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    const calls: string[] = [];
    const setup = new OnePasswordProvisioning(settings, async (operation, input: any) => {
      calls.push(operation);
      expect(operation).toBe("import-token");
      expect(input.token).toBe("ops_synthetic_manual_token");
      return [connection];
    });
    await expect(setup.importToken("invalid")).rejects.toThrow("valid");
    expect(calls).toEqual([]);
    const result = await setup.importToken("ops_synthetic_manual_token");
    expect(result.credentialProvider).toMatchObject({ broker: true, account: "service-account" });
    expect(JSON.stringify(result)).not.toContain("ops_synthetic_manual_token");
    await settings.update({ account: "legacy", vault: "legacy-vault" });
    const run = brokerCredentialCommand(settings, async () => { throw new Error("Unexpected backend operation"); }, async () => { throw new Error("Must never invoke local CLI"); });
    await expect(run("op", ["item", "list", "--account", "legacy", "--vault", "legacy-vault"])).rejects.toThrow("Local vault reads are disabled");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancelled token registration releases setup and allows retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "manual-cancel-"));
  try {
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    let cancel = true;
    const setup = new OnePasswordProvisioning(settings, async (_operation, _input, signal) => {
      if (!cancel) return [connection];
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    const pending = setup.importToken("ops_synthetic_manual_token");
    await expect(setup.importToken("ops_synthetic_manual_token")).rejects.toThrow("already running");
    setup.cancel();
    await expect(pending).rejects.toThrow("cancelled");
    cancel = false;
    expect((await setup.importToken("ops_synthetic_manual_token")).credentialProvider?.broker).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("server metadata recovers a manual registration after its response is lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "manual-recovery-"));
  try {
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    const setup = new OnePasswordProvisioning(settings, async operation => {
      if (operation === "import-token") throw new Error("Response lost");
      expect(operation).toBe("view");
      return [connection];
    });
    await expect(setup.importToken("ops_synthetic_manual_token")).rejects.toThrow("Response lost");
    expect((await setup.refresh()).credentialProvider?.vault).toBe("vault");
  } finally { await rm(root, { recursive: true, force: true }); }
});
