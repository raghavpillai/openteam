import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { networkStore } from "../src/services/browser-network-service";

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)(
  "ranked settings initialize, persist, migrate legacy selections and reject conflicting changes",
  async () => {
    const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
    const store = networkStore(db);
    try {
      const initial = await store.read();
      expect(initial.mode).toBe("ranked");
      expect(initial.machineId).toBeNull();
      expect(initial.sourceOrder).toEqual(["server"]);
      expect((await networkStore(db).read()).deploymentId).toBe(initial.deploymentId);
      const machineId = crypto.randomUUID();
      const results = await Promise.all([
        store.change(initial.revision, "ranked", null, [machineId, "server"]),
        store.change(initial.revision, "ranked", null, ["server"]),
      ]);
      expect(results.filter(Boolean).length).toBe(1);
      expect(results.filter((x) => x === null).length).toBe(1);
      const current = await store.read();
      expect(current.revision).toBe(initial.revision + 1);
      const order = [machineId, "server", crypto.randomUUID()];
      const ranked = await store.change(current.revision, "ranked", null, order);
      expect(ranked!.mode).toBe("ranked");
      expect((await networkStore(db).read()).sourceOrder).toEqual(order);
      expect(await store.change(current.revision, "ranked", null, [...order].reverse())).toBeNull();
      // A previously pinned device becomes first in a ranked list with a server fallback.
      await db.browserNetworkSettings.update({
        where: { id: "global" },
        data: { mode: "device", machineId, sourceOrder: [], revision: { increment: 1 } },
      });
      const legacy = await store.read();
      expect(legacy.mode).toBe("ranked");
      expect(legacy.machineId).toBeNull();
      expect(legacy.sourceOrder).toEqual([machineId, "server"]);
      expect((await store.read()).revision).toBe(legacy.revision);
      // A previous explicit server choice keeps the server ahead of existing computers.
      await db.browserNetworkSettings.update({
        where: { id: "global" },
        data: {
          mode: "server",
          machineId: null,
          sourceOrder: [machineId, "server"],
          revision: { increment: 1 },
        },
      });
      const migrated = await Promise.all([store.read(), networkStore(db).read()]);
      for (const value of migrated) {
        expect(value.mode).toBe("ranked");
        expect(value.sourceOrder).toEqual(["server", machineId]);
      }
      expect(migrated[0].revision).toBe(migrated[1].revision);
    } finally {
      await db.browserNetworkSettings.deleteMany();
      await db.$disconnect();
    }
  }
);
