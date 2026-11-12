import { describe, expect, test } from "bun:test";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import { WakeWorker } from "../src/worker";

const uuidAt = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

describe("bounded periodic reconciliation", () => {
  test("a deleted chat is never adopted back from its directory residue", async () => {
    const deletedGroupId = uuidAt(2_001);
    const deletedBotId = uuidAt(2_002);
    const records = [
      {
        id: deletedGroupId,
        kind: "group" as const,
        name: "Delete me",
        description: "",
        title: "",
        createdAt: 1,
        updatedAt: 1,
        hasStore: true,
        notifyOnAgentUpdates: true,
        hiddenFromSidebar: false,
        memberIds: [uuidAt(2_003)],
      },
      {
        id: deletedBotId,
        kind: "agent" as const,
        name: "Gone",
        description: "",
        title: "",
        createdAt: 2,
        updatedAt: 2,
        hasStore: true,
        notifyOnAgentUpdates: true,
        hiddenFromSidebar: false,
        memberIds: [],
      },
    ];
    const deleted: string[] = [];
    const adopted: string[] = [];
    const worker = Object.create(WakeWorker.prototype) as WakeWorker;
    Object.defineProperties(worker, {
      agentStoreEtag: { value: null, writable: true },
      pendingAgentStoreRecords: { value: new Map(), writable: true },
      prisma: {
        value: {
          bot: { findMany: async () => [] },
          channel: { findMany: async () => [] },
          retiredAgent: { findMany: async () => records.map(({ id }) => ({ id })) },
          $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
            adopted.push("transaction");
            return work({ $executeRaw: async () => 0 });
          },
        },
      },
      computerFetch: {
        value: async (path: string, init: RequestInit) => {
          if (init.method === "DELETE") {
            deleted.push(path);
            return Response.json({ ok: true, removed: true });
          }
          if (init.method === "GET") {
            return Response.json({ agents: records }, { headers: { etag: '"roster"' } });
          }
          throw new Error(`unexpected agent store reconcile call: ${init.method} ${path}`);
        },
      },
    });
    const reconcile = worker as unknown as {
      reconcileAgentStores(backfill: boolean): Promise<number>;
    };

    expect(await reconcile.reconcileAgentStores(false)).toBe(0);
    expect(adopted).toEqual([]);
    expect(deleted).toEqual([
      COMPUTER_API_PATHS.agentStore(deletedGroupId),
      COMPUTER_API_PATHS.agentStore(deletedBotId),
    ]);
  });
  for (const failure of ["network", "http"] as const) {
    test(`failed ${failure} retirement retries on 304 and survives pruned events`, async () => {
      const record = {
        id: uuidAt(3_001), kind: "group", name: "Deleted", description: "", title: "",
        createdAt: 1, updatedAt: 1, hasStore: true, notifyOnAgentUpdates: true,
        hiddenFromSidebar: false, memberIds: [uuidAt(3_002)],
      };
      let deletes = 0;
      let snapshots = 0;
      const worker = Object.create(WakeWorker.prototype) as any;
      Object.assign(worker, {
        agentStoreEtag: null, pendingAgentStoreRecords: new Map(),
        prisma: {
          bot: { findMany: async () => [] },
          channel: { findMany: async () => [] },
          // No event table is needed: pruning the replay log cannot erase retirement.
          retiredAgent: { findMany: async () => [{ id: record.id }] },
          $transaction: async () => { throw new Error("deleted groups must never be adopted"); },
        },
        computerFetch: async (_path: string, init: RequestInit) => {
          if (init.method === "DELETE") {
            deletes++;
            if (deletes === 1) {
              if (failure === "network") throw new Error("offline");
              return new Response("offline", { status: 503 });
            }
            return Response.json({ ok: true });
          }
          snapshots++;
          return snapshots === 1
            ? Response.json({ agents: [record] }, { headers: { etag: '"stable"' } })
            : new Response(null, { status: 304 });
        },
      });
      expect(await worker.reconcileAgentStores(false)).toBe(0);
      expect(worker.pendingAgentStoreRecords.size).toBe(1);
      expect(await worker.reconcileAgentStores(false)).toBe(0);
      expect(deletes).toBe(2);
      expect(worker.pendingAgentStoreRecords.size).toBe(0);
      expect(await worker.reconcileAgentStores(false)).toBe(0);
      expect(deletes).toBe(2);
    });
  }

});
