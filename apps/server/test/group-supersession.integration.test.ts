import { expect } from "bun:test";
import { Effect } from "effect";
import type { ToolContext } from "@openteam/messaging";
import { ChannelService } from "../src/services/channel-service";
import { bareWorker, dbIt, gate, interceptTransactions, type Harness } from "./harness";

async function fixture(h: Harness) {
  const bots = [await h.bot("Alpha", { notificationsEnabled: false }, { dm: false }), await h.bot("Beta", { notificationsEnabled: false }, { dm: false })];
  const channel = await h.channel({ kind: "group", name: "Supersession QA", members: { create: bots.map((b, ordinal) => ({ botId: b.id, ordinal })) } });
  const cancelled: string[] = [];
  const service = new ChannelService(h.db, h.messaging, h.dir, async path => { cancelled.push(path); return new Response(null); });
  const post = (content: string) => Effect.runPromise(service.sendGroupMessage(channel.id, { content, clientId: crypto.randomUUID() }));
  const start = async (content: string) => {
    const accepted = await post(content);
    await h.messaging.advanceRound(accepted.round.id);
    const run = await h.db.run.findFirstOrThrow({ where: { delivery: { round: { rootMessageId: accepted.message.id } } }, orderBy: { createdAt: "asc" } });
    return { ...accepted, run };
  };
  const context = (run: { id: string; botId: string; conversationId: string; deliveryId: string | null; origin: ToolContext["origin"] }): ToolContext => ({
    runId: run.id, botId: run.botId, conversationId: run.conversationId, channelId: channel.id, deliveryId: run.deliveryId, origin: run.origin, callId: crypto.randomUUID(), isFork: false, replyToMessageId: null,
  });
  return { bots, channel, post, start, context, cancelled };
}

dbIt("a worker candidate selected before supersession cannot revive the cancelled run", async h => {
  const f = await fixture(h);
  const old = await f.start("Original queued work");
  const selected = gate(), release = gate();
  const prisma = interceptTransactions(h.db, (tx, property) => property !== "inboxEvent" ? undefined : { ...tx.inboxEvent, findMany: async (args: any) => {
    const candidates = await tx.inboxEvent.findMany(args);
    if (args?.where?.OR && args.where.botId) {
      expect(candidates.some((candidate: { runId: string }) => candidate.runId === old.run.id)).toBe(true);
      selected.resolve(); await release.promise;
    }
    return candidates;
  } });
  const claiming = bareWorker({ prisma, messaging: h.messaging, agentData: h.store }).claim(old.run.botId);
  try {
    await selected.promise;
    const replacement = await f.post("Replacement cancels selected work");
    release.resolve();
    expect(await claiming).toBeNull();
    expect((await h.db.run.findUniqueOrThrow({ where: { id: old.run.id } })).status).toBe("cancelled");
    expect((await h.db.channelDelivery.findUniqueOrThrow({ where: { id: old.run.deliveryId! } })).status).toBe("skipped");
    expect(await h.db.botRunLease.count({ where: { runId: old.run.id } })).toBe(0);
    await h.messaging.advanceRound(replacement.round.id);
  } finally { release.resolve(); await claiming.catch(() => undefined); }
}, 20_000);

dbIt("new group messages discard old buffered replies, skip old peers, and retain every user input", async h => {
  const f = await fixture(h);
  const old = await f.start("First request");
  await h.messaging.sendVisible(f.context(old.run), { type: "text", content: "obsolete" });
  const middle = await f.start("Second request");
  const latest = await f.start("@Beta Third request replaces prior work");
  for (const run of [old.run, middle.run]) expect((await h.db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("cancelled");
  await expect(h.messaging.sendVisible(f.context(old.run), { type: "text", content: "late" })).rejects.toThrow("no longer active");
  await h.messaging.completeDelivery(old.run.deliveryId!, "completed", undefined, old.run.id);
  await h.messaging.retryInterruptedGroupDelivery(old.run.deliveryId!, old.run.id);
  expect(await h.db.channelMessage.count({ where: { channelId: f.channel.id, sender: "agent" } })).toBe(0);
  expect(await h.db.channelDelivery.count({ where: { roundId: old.round.id, status: { not: "skipped" } } })).toBe(0);
  expect(latest.run.botId).toBe(f.bots[1]!.id);
  const prompt = await h.db.message.findUniqueOrThrow({ where: { id: latest.run.userMessageId } });
  for (const text of ["First request", "Second request", "Third request"]) expect(prompt.content).toContain(text);
  expect(f.cancelled.some(path => path.includes(old.run.id))).toBe(true);
});
