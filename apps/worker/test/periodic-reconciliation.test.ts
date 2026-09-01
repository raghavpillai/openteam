import { describe, expect, test } from "bun:test";
import { AgentDataStore } from "@openbot/messaging";
import { AUTOMATION_RECONCILE_BATCH_SIZE, WakeWorker } from "../src/worker";

const uuidAt = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

describe("bounded periodic reconciliation", () => {
  test("automation safety sweeps cap each tick and cover every active bot", async () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => uuidAt(index));
    let transactionCount = 0;
    const reconciled: string[] = [];
    const prisma = {
      bot: {
        findMany: async (input: { where: { id?: { gt?: string } }; take: number }) => {
          const after = input.where.id?.gt;
          return ids
            .filter((id) => !after || id > after)
            .slice(0, input.take)
            .map((id) => ({ id }));
        },
      },
      $transaction: async (work: (tx: { $executeRaw: () => Promise<number> }) => Promise<void>) => {
        transactionCount += 1;
        await work({ $executeRaw: async () => 0 });
      },
    };
    const store = new AgentDataStore(prisma as never, { root: "/tmp/openbot-bounded-sweep" });
    Object.defineProperty(store, "reconcileAutomations", {
      value: async (_tx: unknown, botId: string) => {
        reconciled.push(botId);
      },
    });

    let cursor: string | null = null;
    let passes = 0;
    do {
      const before = transactionCount;
      const result = await store.reconcileAutomationFilesBatch(
        cursor,
        AUTOMATION_RECONCILE_BATCH_SIZE
      );
      expect(transactionCount - before).toBeLessThanOrEqual(AUTOMATION_RECONCILE_BATCH_SIZE);
      cursor = result.nextCursor;
      passes += 1;
    } while (cursor !== null);

    expect(passes).toBe(125);
    expect(transactionCount).toBe(1_000);
    expect(reconciled).toEqual(ids);
    // The previous implementation did all 1,000 transactions on every one-second tick.
    expect(AUTOMATION_RECONCILE_BATCH_SIZE).toBe(8);
  });

  test("unchanged agent/group snapshots use bulk lookups, then a conditional no-op", async () => {
    const records = Array.from({ length: 1_000 }, (_, index) => ({
      id: uuidAt(index),
      kind: index < 500 ? ("agent" as const) : ("group" as const),
      name: index < 500 ? `Bot ${index}` : `Group ${index}`,
      description: "",
      title: "",
      createdAt: index,
      updatedAt: index,
      hasStore: true,
      notifyOnAgentUpdates: true,
      hiddenFromSidebar: false,
      memberIds: index < 500 ? [] : [uuidAt(0)],
    }));
    let fetchCount = 0;
    let bulkBotLookups = 0;
    let bulkChannelLookups = 0;
    const worker = Object.create(WakeWorker.prototype) as WakeWorker;
    Object.defineProperties(worker, {
      agentStoreEtag: { value: null, writable: true },
      pendingAgentStoreRecords: { value: new Map(), writable: true },
      prisma: {
        value: {
          bot: {
            findMany: async () => {
              bulkBotLookups += 1;
              return records.filter(({ kind }) => kind === "agent").map(({ id }) => ({ id }));
            },
          },
          channel: {
            findMany: async () => {
              bulkChannelLookups += 1;
              return records.filter(({ kind }) => kind === "group").map(({ id }) => ({ id }));
            },
          },
          $transaction: async () => {
            throw new Error("existing records must not open adoption transactions");
          },
        },
      },
      computerFetch: {
        value: async (_path: string, init: RequestInit) => {
          fetchCount += 1;
          if (fetchCount === 1) {
            expect(init.headers).toBeUndefined();
            return Response.json({ agents: records }, { headers: { etag: '"stable-roster"' } });
          }
          expect(new Headers(init.headers).get("if-none-match")).toBe('"stable-roster"');
          return new Response(null, { status: 304, headers: { etag: '"stable-roster"' } });
        },
      },
    });
    const reconcile = worker as unknown as {
      reconcileAgentStores(backfill: boolean): Promise<number>;
    };

    expect(await reconcile.reconcileAgentStores(false)).toBe(0);
    expect(await reconcile.reconcileAgentStores(false)).toBe(0);
    expect(fetchCount).toBe(2);
    expect(bulkBotLookups).toBe(1);
    expect(bulkChannelLookups).toBe(1);
  });
});
