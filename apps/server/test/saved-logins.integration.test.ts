import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { SavedLoginService } from "../src/services/saved-login-service";

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)(
  "saved login broker verifies vault scope, preserves provider rules, renews once and revokes racing reads",
  async () => {
    const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
    const accountId = crypto.randomUUID(),
      vaultId = crypto.randomUUID();
    const connectionId = `1password:${accountId}:${vaultId}`;
    let extraVault = false;
    let duringRead: (() => Promise<void>) | undefined;
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
              extraVault ? [{ id: vaultId }, { id: "too-broad" }] : [{ id: vaultId }],
          },
          items: {
            list: async () => [overview],
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
        }) as any
    );
    try {
      const ticket = await service.begin({ accountId, vaultId, vaultName: "Fixture" });
      const complete = { mintTicket: ticket.mintTicket, token: "synthetic-service-account-token" };
      extraVault = true;
      await expect(service.complete(complete)).rejects.toThrow("selected vault");
      extraVault = false;
      const view = await service.complete(complete);
      expect(JSON.stringify(view)).not.toContain(complete.token);
      expect(view[0]?.generation).toBe(1);
      await service.complete(complete);
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
      const renewal = await service.begin({
        accountId,
        vaultId,
        vaultName: "Fixture",
        connectionId,
      });
      await service.complete({
        mintTicket: renewal.mintTicket,
        token: "renewed-synthetic-service-token",
      });
      expect((await service.view())[0]?.generation).toBe(2);
      await expect(service.complete(complete)).rejects.toThrow();
      duringRead = () => service.disconnect(connectionId).then(() => undefined);
      await expect(
        service.operation({ operation: "get", accountId, vaultId, itemId: "fixture-login" })
      ).rejects.toThrow("connection changed");
      expect(
        (await db.savedLoginConnection.findUniqueOrThrow({ where: { id: connectionId } })).token
      ).toBeNull();
      expect(await service.view()).toEqual([]);
    } finally {
      await db.savedLoginMint.deleteMany({ where: { connectionId } });
      await db.savedLoginConnection.deleteMany({ where: { id: connectionId } });
      await db.$disconnect();
    }
  }
);
