import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { SavedLoginService } from "../src/services/saved-login-service";
import { SavedLoginTokenCipher } from "../src/services/saved-login-token";
import { AuthExpiredError } from "@1password/sdk";

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)(
  "saved login broker verifies vault scope, preserves provider rules, renews once and revokes racing reads",
  async () => {
    const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
    const accountId = "service-account",
      vaultId = crypto.randomUUID();
    const connectionId = `1password:${accountId}:${vaultId}`;
    let noVault = false;
    let duringRead: (() => Promise<void>) | undefined;
    let listFailure: Error | undefined;
    const overview = {
      id: "fixture-login",
      title: "Fixture",
      category: "Login",
      state: "active",
      updatedAt: new Date("2026-01-01"),
      websites: [{ url: "https://login.example.com", autofillBehavior: "ExactDomain" }],
    };
    const service = new SavedLoginService(
      db,
      async () =>
        ({
          vaults: {
            list: async () =>
              noVault ? [] : [{ id: vaultId, title: "Existing Work Vault" }],
          },
          items: {
            list: async () => {
              if (listFailure) throw listFailure;
              return [overview];
            },
            get: async () => {
              await duringRead?.();
              return {
                ...overview,
                fields: [
                  { id: "username", value: "fixture-user" },
                  { id: "password", value: "fixture-password" },
                  { id: "other", value: "not-requested" },
                ],
              };
            },
          },
        }) as any,
      new SavedLoginTokenCipher(() => "synthetic-integration-test-secret-32-characters")
    );
    try {
      const complete = {
        token: "ops_synthetic_service_account_token",
      };
      noVault = true;
      await expect(service.importToken(complete)).rejects.toThrow("read access");
      noVault = false;
      const view = await service.importToken(complete);
      expect(JSON.stringify(view)).not.toContain(complete.token);
      const stored = await db.savedLoginConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(stored.token).toStartWith("enc:v1:");
      expect(stored.token).not.toContain(complete.token);
      expect(view[0]?.generation).toBe(1);
      expect(view[0]).toMatchObject({
        alwaysAllow: false,
        permissionRevision: 1,
        itemCount: 1,
        lifecycleState: "active",
        lastSyncErrorCode: null,
      });
      expect(view[0]?.lastSuccessfulSyncAt).toBeInstanceOf(Date);
      await expect(service.setAlwaysAllow({ connectionId, alwaysAllow: "true" })).rejects.toThrow();
      expect((await service.setAlwaysAllow({ connectionId, alwaysAllow: true }))[0]).toMatchObject({
        alwaysAllow: true,
        permissionRevision: 2,
      });
      duringRead = () =>
        service.setAlwaysAllow({ connectionId, alwaysAllow: false }).then(() => undefined);
      await expect(
        service.operation({ operation: "get", accountId, vaultId, itemId: "fixture-login" })
      ).rejects.toThrow("connection changed");
      expect((await service.view())[0]).toMatchObject({
        alwaysAllow: false,
        permissionRevision: 3,
        lastSyncErrorCode: null,
      });
      duringRead = undefined;
      listFailure = new AuthExpiredError("synthetic-provider-message-not-for-users");
      const rejected = await service.sync({ connectionId });
      expect(rejected[0]).toMatchObject({
        lifecycleState: "provider-rejected",
        lastSyncErrorCode: "provider-rejected",
        itemCount: 1,
      });
      expect(JSON.stringify(rejected)).not.toContain(listFailure.message);
      listFailure = new Error("synthetic-network-details");
      expect((await service.sync({ connectionId }))[0]?.lastSyncErrorCode).toBe(
        "provider-unavailable"
      );
      listFailure = undefined;
      expect((await service.sync({ connectionId }))[0]).toMatchObject({
        lifecycleState: "active",
        lastSyncErrorCode: null,
        itemCount: 1,
      });
      await expect(service.sync({ connectionId: "unknown" })).rejects.toThrow("unavailable");
      expect(
        (await db.savedLoginConnection.findUniqueOrThrow({ where: { id: connectionId } }))
          .generation
      ).toBe(1);
      const list = await service.operation({ operation: "list", accountId, vaultId });
      if (!Array.isArray(list)) throw new Error("Expected metadata list");
      expect(list[0]!.urls[0].autofillBehavior).toBe("ExactDomain");
      expect(JSON.stringify(list)).not.toContain("fixture-password");
      const item = await service.operation({
        operation: "get",
        accountId,
        vaultId,
        itemId: "fixture-login",
      });
      if (Array.isArray(item)) throw new Error("Expected one item");
      expect(item.fields).toHaveLength(2);
      expect(item.updated_at).toBe(list[0]!.updated_at);
      await service.importToken({ token: "ops_renewed_synthetic_service_token" });
      expect((await service.view())[0]?.generation).toBe(2);
      duringRead = () => service.disconnect(connectionId).then(() => undefined);
      await expect(
        service.operation({ operation: "get", accountId, vaultId, itemId: "fixture-login" })
      ).rejects.toThrow("connection changed");
      expect(
        (await db.savedLoginConnection.findUniqueOrThrow({ where: { id: connectionId } })).token
      ).toBeNull();
      expect(await service.view()).toEqual([]);
    } finally {
      await db.savedLoginConnection.deleteMany({ where: { id: connectionId } });
      await db.$disconnect();
    }
  }
);

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)(
  "manual service-account import accepts an existing vault, encrypts tokens and replaces access without local setup",
  async () => {
    const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
    const vaultId = crypto.randomUUID();
    const connectionId = `1password:service-account:${vaultId}`;
    let vaultTitle = "Existing Engineering Vault", failRead = false;
    const tokens: string[] = [];
    const token = "ops_synthetic_imported_private_token";
    const cipher = new SavedLoginTokenCipher(() => "synthetic-integration-test-secret-32-characters");
    const service = new SavedLoginService(db, async value => {
      tokens.push(value);
      return {
        vaults: { list: async () => [{ id: vaultId, title: vaultTitle }, ] },
        items: { list: async () => { if (failRead) throw new Error("Synthetic permission failure"); return [{ id: "fixture-login", title: "Fixture", category: "Login", state: "active", websites: [], updatedAt: new Date() }]; } },
      } as any;
    }, cipher);
    try {
      await expect(service.importToken({ token: "invalid" })).rejects.toThrow("Invalid");
      failRead = true;
      await expect(service.importToken({ token })).rejects.toThrow("read access");
      expect(await service.view()).toEqual([]);
      failRead = false;
      const result = await service.importToken({ token: ` ${token} ` });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: connectionId, vaultName: "Existing Engineering Vault", itemCount: 1, alwaysAllow: false });
      expect(JSON.stringify(result)).not.toContain(token);
      const stored = await db.savedLoginConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(cipher.decrypt(stored.token!, connectionId)).toBe(token);
      await service.operation({ operation: "list", accountId: "service-account", vaultId });
      expect(tokens.at(-1)).toBe(token);
      await service.setAlwaysAllow({ connectionId, alwaysAllow: true });
      await service.importToken({ token: "ops_synthetic_renewed_manual_token" });
      expect((await service.view())[0]).toMatchObject({ generation: 2, alwaysAllow: false, permissionRevision: 3 });
      await service.disconnect(connectionId);
      expect((await db.savedLoginConnection.findUniqueOrThrow({ where: { id: connectionId } })).token).toBeNull();
      expect(await service.view()).toEqual([]);
    } finally {
      await db.savedLoginConnection.deleteMany({ where: { vaultId } });
      await db.$disconnect();
    }
  }
);

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)(
  "one token connects multiple existing vaults atomically with independent permissions and disconnects",
  async () => {
    const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    const firstId = `1password:service-account:${first}`, secondId = `1password:service-account:${second}`;
    const token = "ops_synthetic_multi_vault_token";
    const cipher = new SavedLoginTokenCipher(() => "synthetic-integration-test-secret-32-characters");
    let failure = true;
    const reads: string[] = [];
    const service = new SavedLoginService(db, async () => ({
      vaults: { list: async () => [{ id: first, title: "Existing Work" }, { id: second, title: "Existing Family" }] },
      items: { list: async (vaultId: string) => {
        reads.push(vaultId);
        if (failure && vaultId === second) throw new Error("Synthetic unreadable vault");
        return [{ id: `login-${vaultId}`, title: "Fixture login", category: "Login", state: "active", updatedAt: new Date(), websites: [] }];
      } },
    }) as any, cipher);
    try {
      await expect(service.importToken({ token })).rejects.toThrow("read access");
      expect(await db.savedLoginConnection.count({ where: { vaultId: { in: [first, second] } } })).toBe(0);
      failure = false;
      const rows = await service.importToken({ token });
      expect(rows.map(row => row.vaultName).sort()).toEqual(["Existing Family", "Existing Work"]);
      expect(rows.every(row => row.alwaysAllow === false)).toBe(true);
      const records = await db.savedLoginConnection.findMany({ where: { vaultId: { in: [first, second] } } });
      for (const row of records) expect(cipher.decrypt(row.token!, row.id)).toBe(token);
      expect(records[0]!.token).not.toBe(records[1]!.token);
      await service.setAlwaysAllow({ connectionId: firstId, alwaysAllow: true });
      expect((await service.view()).find(row => row.id === secondId)?.alwaysAllow).toBe(false);
      await service.disconnect(firstId);
      await expect(service.operation({ operation: "list", accountId: "service-account", vaultId: first })).rejects.toThrow("Renew");
      await service.operation({ operation: "list", accountId: "service-account", vaultId: second });
      expect(reads.at(-1)).toBe(second);
      expect((await service.view()).map(row => row.id)).toEqual([secondId]);
    } finally {
      await db.savedLoginConnection.deleteMany({ where: { vaultId: { in: [first, second] } } });
      await db.$disconnect();
    }
  }
);
