import { expect, test } from "bun:test";
import { Effect } from "effect";
import { GroupAdministration } from "../../src/services/channel/group-administration";

test("group deletion records a durable tombstone before removing the row and tolerates offline cleanup", async () => {
  const order: string[] = [];
  let retired: any;
  const tx = {
    $executeRaw: async () => 0,
    channel: {
      findFirst: async () => ({ members: [{ botId: "member" }] }),
      delete: async () => { order.push("delete-row"); },
    },
    retiredAgent: {
      upsert: async ({ create }: any) => { order.push(`retire:${create.id}`); retired = { cleanupPending: true, ...create }; },
      findUnique: async () => retired,
      update: async ({ data }: any) => { Object.assign(retired, data); },
    },
    contextSession: { findMany: async () => [] },
    run: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    event: { create: async ({ data }: any) => { order.push(data.topic); } },
  };
  const prisma = { ...tx, $transaction: async (work: any) => work(tx) };
  const service = new GroupAdministration(prisma as never, {} as never, "/unused", async () => {
    order.push("runtime-cleanup");
    throw new Error("offline");
  });
  expect(await Effect.runPromise(service.deleteGroup("group"))).toEqual({ deleted: true, channelId: "group" });
  expect(order.slice(0, 3)).toEqual(["retire:group", "delete-row", "channel.deleted"]);
  expect(order.filter((step) => step === "runtime-cleanup")).toHaveLength(3);
  expect(retired.cleanupPending).toBe(true);
});
