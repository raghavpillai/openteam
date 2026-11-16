import { expect, test } from "bun:test";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import { WakeWorker } from "../src/worker";

const uuidAt = (index: number): string => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const store = (id: string, kind: "group" | "agent", memberIds: string[]) => ({
  id, kind, name: "Deleted", description: "", title: "", createdAt: 1, updatedAt: 1,
  hasStore: true, notifyOnAgentUpdates: true, hiddenFromSidebar: false, memberIds,
});

test("deleted chats are never adopted back from directory residue, and failed retirements retry on 304", async () => {
  const group = store(uuidAt(2_001), "group", [uuidAt(2_003)]);
  const bot = store(uuidAt(2_002), "agent", []);
  const deletes: string[] = [];
  let snapshots = 0;
  const worker = Object.create(WakeWorker.prototype) as any;
  Object.assign(worker, {
    agentStoreEtag: null,
    pendingAgentStoreRecords: new Map(),
    prisma: {
      bot: { findMany: async () => [] },
      channel: { findMany: async () => [] },
      // No event table is needed: pruning the replay log cannot erase retirement.
      retiredAgent: { findMany: async () => [{ id: group.id }, { id: bot.id }] },
      $transaction: async () => { throw new Error("deleted chats must never be adopted"); },
    },
    computerFetch: async (path: string, init: RequestInit) => {
      if (init.method === "DELETE") {
        deletes.push(path);
        // The first attempt fails once by network and once by HTTP status.
        if (deletes.length === 1) throw new Error("offline");
        if (deletes.length === 2) return new Response("offline", { status: 503 });
        return Response.json({ ok: true, removed: true });
      }
      return ++snapshots === 1
        ? Response.json({ agents: [group, bot] }, { headers: { etag: '"stable"' } })
        : new Response(null, { status: 304 });
    },
  });
  expect(await worker.reconcileAgentStores(false)).toBe(0);
  expect(worker.pendingAgentStoreRecords.size).toBe(2);
  expect(await worker.reconcileAgentStores(false)).toBe(0);
  expect(worker.pendingAgentStoreRecords.size).toBe(0);
  expect(await worker.reconcileAgentStores(false)).toBe(0);
  const paths = [COMPUTER_API_PATHS.agentStore(group.id), COMPUTER_API_PATHS.agentStore(bot.id)];
  expect(deletes).toEqual([...paths, ...paths]);
});
