import { expect, test } from "bun:test";
import { Effect } from "effect";
import { GroupAdministration } from "../../src/services/channel/group-administration";

test("group deletion records a durable tombstone before removing the row and tolerates offline cleanup", async () => {
  const order: string[] = [];
  const tx = {
    $executeRaw: async () => 0,
    channel: {
      findFirst: async () => ({ members: [{ botId: "member" }] }),
      delete: async () => { order.push("delete-row"); },
    },
    retiredAgent: { upsert: async ({ create }: any) => { order.push(`retire:${create.id}`); } },
    run: { findMany: async () => [] },
    event: { create: async ({ data }: any) => { order.push(data.topic); } },
  };
  const prisma = { $transaction: async (work: any) => work(tx) };
  const service = new GroupAdministration(prisma as never, {} as never, "/unused", async () => {
    order.push("runtime-cleanup");
    throw new Error("offline");
  });
  expect(await Effect.runPromise(service.deleteGroup("group"))).toEqual({ deleted: true, channelId: "group" });
  expect(order).toEqual(["retire:group", "delete-row", "channel.deleted", "runtime-cleanup"]);
});
