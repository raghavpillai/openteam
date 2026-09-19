import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OnePasswordProvisioning,
  provisioningEnvironment,
  brokerCredentialCommand,
} from "../../src/main/host/onepassword-provisioning";
import { CapabilitySettingsStore } from "../../src/main/host/capability-settings";
import { credentialRules, matchCredentialRules } from "../../src/main/host/credential-domain";
import { onePasswordError } from "@openteam/contracts/saved-logins";

test("service-account setup uses one read-only vault, retries ambiguous completion without minting twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "provisioning-"));
  const commands: string[][] = [];
  const requests: any[] = [];
  let fail = true;
  try {
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    const provisioning = new OnePasswordProvisioning(
      settings,
      async (operation, input) => {
        requests.push({ operation, input });
        if (operation === "begin")
          return {
            mintTicket: "ticket",
            connectionId: "1password:account:vault",
            expectedGeneration: 0,
            providerExpiresInSeconds: 3600,
          };
        if (operation === "complete" && fail) throw new Error("Response lost");
        if (operation === "complete")
          return [
            {
              id: "1password:account:vault",
              accountId: "account",
              vaultId: "vault",
              vaultName: "OpenTeam",
              generation: 1,
            },
          ];
        return [];
      },
      async (_, args) => {
        commands.push(args);
        if (args[0] === "account")
          return JSON.stringify([{ account_uuid: "account", email: "fixture@example.test" }]);
        if (args[1] === "list") return JSON.stringify([{ id: "vault", name: "OpenTeam" }]);
        if (args[0] === "service-account") return "ops_synthetic_service_account_token";
        throw new Error("Unexpected command");
      }
    );
    expect(await provisioning.accounts()).toEqual([
      { id: "account", label: "fixture@example.test" },
    ]);
    await expect(
      provisioning.connect({ account: "account", vaultName: "OpenTeam" })
    ).rejects.toThrow("completion-pending");
    await expect(
      provisioning.connect({ account: "account", vaultName: "OpenTeam" })
    ).rejects.toThrow("pending");
    expect(commands.filter((args) => args[0] === "service-account")).toHaveLength(1);
    expect(commands.at(-1)).toContain("vault:read_items");
    fail = false;
    const result = await provisioning.finish();
    expect(result.credentialProvider).toMatchObject({
      account: "account",
      vault: "vault",
      broker: true,
    });
    expect(JSON.stringify(result)).not.toContain("ops_synthetic_service_account_token");
    expect(requests.filter((row) => row.operation === "complete")[0].input).toEqual(
      requests.at(-1).input
    );
    const run = brokerCredentialCommand(
      settings,
      async (operation, input) => {
        if (operation === "view")
          return [{ accountId: "account", vaultId: "vault", vaultName: "OpenTeam", generation: 1 }];
        expect(operation).toBe("operation");
        expect(input).toEqual({
          operation: "get",
          accountId: "account",
          vaultId: "vault",
          itemId: "item",
        });
        return { id: "item" };
      },
      async () => {
        throw new Error("Must not access local vault");
      }
    );
    expect(
      await run("op", [
        "item",
        "get",
        "item",
        "--account",
        "account",
        "--vault",
        "vault",
        "--format=json",
      ])
    ).toBe('{"id":"item"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("provider hostname and never-fill behavior survives conversion", () => {
  const exact = credentialRules([
    { href: "https://login.example.com", autofillBehavior: "ExactDomain" },
  ]);
  expect(matchCredentialRules(exact, "https://login.example.com", true)).toBe(true);
  expect(matchCredentialRules(exact, "https://other.example.com")).toBe(false);
  expect(credentialRules([{ href: "https://example.com", autofillBehavior: "Never" }])).toEqual([]);
  expect(
    credentialRules([{ href: "https://example.com", autofillBehavior: "future-unknown-mode" }])
  ).toEqual([]);
  expect(
    provisioningEnvironment({
      OP_SERVICE_ACCOUNT_TOKEN: "do-not-inherit",
      DYLD_INSERT_LIBRARIES: "/synthetic/not-loaded.dylib",
      OP_CONNECT_TOKEN: "private",
      PATH: "/usr/bin",
    })
  ).toEqual({
    PATH: "/usr/bin",
    OP_CACHE: "false",
    OP_BIOMETRIC_UNLOCK_ENABLED: "true",
    OP_LOAD_DESKTOP_APP_SETTINGS: "false",
  });
});

test("interrupted mint requires an explicit restart and server metadata recovers completed connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "provisioning-recovery-"));
  let mints = 0;
  try {
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    const provisioning = new OnePasswordProvisioning(
      settings,
      async (operation) =>
        operation === "view"
          ? [{ accountId: "account", vaultId: "vault", vaultName: "Recovered" }]
          : {
              mintTicket: "ticket",
              connectionId: "1password:account:vault",
              expectedGeneration: 0,
              providerExpiresInSeconds: 3600,
            },
      async (_, args) => {
        if (args[0] === "vault") return JSON.stringify([{ id: "vault", name: "Recovered" }]);
        mints++;
        throw new Error("Connection lost while minting");
      }
    );
    await expect(
      provisioning.connect({ account: "account", vaultName: "Recovered" })
    ).rejects.toThrow("delivery-indeterminate");
    await expect(
      provisioning.connect({ account: "account", vaultName: "Recovered" })
    ).rejects.toThrow("previous setup");
    expect(mints).toBe(1);
    expect((await provisioning.refresh()).credentialProvider).toMatchObject({
      account: "account",
      vault: "vault",
      broker: true,
    });
    provisioning.acknowledgeUncertainSetup();
    await expect(
      provisioning.connect({ account: "account", vaultName: "Recovered" })
    ).rejects.toThrow("delivery-indeterminate");
    expect(mints).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling account discovery stops the native operation and permits retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "provisioning-cancel-"));
  try {
    let first = true;
    const provisioning = new OnePasswordProvisioning(
      new CapabilitySettingsStore(join(root, "settings.json")),
      async () => [],
      async (_file, _args, signal) => {
        if (!first) return "[]";
        first = false;
        return new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
        );
      }
    );
    const pending = provisioning.accounts();
    provisioning.cancel();
    await expect(pending).rejects.toThrow("cancelled");
    expect(await provisioning.accounts()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup checks readiness before mutation, validates completion, and retries explicit denials", async () => {
  const root = await mkdtemp(join(tmpdir(), "provisioning-validation-"));
  try {
    const settings = new CapabilitySettingsStore(join(root, "settings.json"));
    let ready = false,
      denied = true,
      validCompletion = false,
      mints = 0,
      requests = 0;
    const provisioning = new OnePasswordProvisioning(
      settings,
      async (operation) => {
        requests++;
        return operation === "begin"
          ? {
              mintTicket: "ticket",
              connectionId: "1password:account:vault",
              expectedGeneration: 2,
              providerExpiresInSeconds: 60,
            }
          : [
              {
                id: "1password:account:vault",
                accountId: "account",
                vaultId: "vault",
                vaultName: "Fixture",
                generation: validCompletion ? 3 : 2,
              },
            ];
      },
      async (_, args) => {
        if (args[0] === "vault") return JSON.stringify([{ id: "vault", name: "Fixture" }]);
        mints++;
        expect(args).toContain("60s");
        expect(args).toContain("vault:read_items");
        if (denied) throw onePasswordError("permission");
        return "ops_synthetic_private_fixture";
      },
      async () => {
        if (!ready) throw new Error("not ready");
      }
    );
    await expect(
      provisioning.connect({ account: "account", vaultName: "Fixture" })
    ).rejects.toThrow("not ready");
    expect(requests).toBe(0);
    expect(mints).toBe(0);
    ready = true;
    await expect(
      provisioning.connect({ account: "account", vaultName: "Fixture" })
    ).rejects.toThrow("[permission]");
    denied = false;
    await expect(
      provisioning.connect({ account: "account", vaultName: "Fixture" })
    ).rejects.toThrow("completion-pending");
    expect((await settings.read()).credentialProvider).toBeNull();
    validCompletion = true;
    expect((await provisioning.finish()).credentialProvider).toMatchObject({ generation: 3 });
    expect(mints).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling a backend mint ticket stops setup before creating a service account", async () => {
  const root = await mkdtemp(join(tmpdir(), "provisioning-ticket-cancel-"));
  try {
    let begun!: () => void,
      mints = 0;
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const provisioning = new OnePasswordProvisioning(
      new CapabilitySettingsStore(join(root, "settings.json")),
      async (_operation, _input, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
          begun();
        }),
      async (_, args) => {
        if (args[0] === "service-account") mints++;
        return JSON.stringify([{ id: "vault", name: "Fixture" }]);
      }
    );
    const pending = provisioning.connect({ account: "account", vaultName: "Fixture" });
    await started;
    provisioning.cancel();
    await expect(pending).rejects.toThrow("cancelled");
    expect(mints).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
