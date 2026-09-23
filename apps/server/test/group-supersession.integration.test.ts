import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging, type ToolContext } from "@openteam/messaging";
import { ChannelService } from "../src/services/channel-service";
import { WakeWorker } from "../../worker/src/worker";

const db = process.env.OPENTEAM_TEST_DATABASE_URL
  ? createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL)
  : null;
afterAll(() => db?.$disconnect());

async function fixture() {
  const bots = await Promise.all(
    ["Alpha", "Beta"].map((name) =>
      db!.bot.create({
        data: {
          name,
          status: "active",
          defaultDirectory: "/tmp",
          notificationsEnabled: false,
          conversation: { create: {} },
        },
        include: { conversation: true },
      })
    )
  );
  const channel = await db!.channel.create({
    data: {
      kind: "group",
      name: "Supersession QA",
      members: { create: bots.map((b, ordinal) => ({ botId: b.id, ordinal })) },
    },
  });
  const messaging = new AgentMessaging(
    db!,
    { send: async () => null, sendDebounced: async () => null } as never,
    new AgentDataStore(db!, {
      root: `/tmp/group-supersession-${channel.id}`,
      workspaceRoot: "/tmp",
    })
  );
  const cancelled: string[] = [];
  const service = new ChannelService(db!, messaging, "/tmp", async (path) => {
    cancelled.push(path);
    return new Response(null);
  });
  const post = (content: string, clientId = randomUUID()) =>
    Effect.runPromise(service.sendGroupMessage(channel.id, { content, clientId }));
  const runFor = async (rootId: string) =>
    db!.run.findFirstOrThrow({
      where: { delivery: { round: { rootMessageId: rootId } } },
      orderBy: { createdAt: "asc" },
    });
  const context = (run: Awaited<ReturnType<typeof runFor>>): ToolContext => ({
    runId: run.id,
    botId: run.botId,
    conversationId: run.conversationId,
    channelId: channel.id,
    deliveryId: run.deliveryId,
    origin: run.origin,
    callId: randomUUID(),
    isFork: false,
    replyToMessageId: null,
  });
  const start = async (content: string, clientId = randomUUID()) => {
    const accepted = await post(content, clientId);
    await messaging.advanceRound(accepted.round.id);
    return { ...accepted, run: await runFor(accepted.message.id) };
  };
  const cleanup = async () => {
    const deliveries = await db!.channelDelivery.findMany({
      where: { round: { channelId: channel.id } },
      select: { id: true },
    });
    await db!.idempotencyRecord.deleteMany({
      where: {
        OR: [
          { scope: `channel:${channel.id}:message` },
          ...deliveries.map((d) => ({ scope: { startsWith: `group-outbox:${d.id}:` } })),
        ],
      },
    });
    await db!.channel.delete({ where: { id: channel.id } });
    await db!.bot.deleteMany({ where: { id: { in: bots.map((b) => b.id) } } });
  };
  return { bots, channel, messaging, service, post, start, runFor, context, cancelled, cleanup };
}

test.skipIf(!db)(
  "a worker candidate selected before supersession cannot revive the cancelled run",
  async () => {
    const f = await fixture();
    let selected!: () => void, release!: () => void;
    const selection = new Promise<void>((resolve) => {
      selected = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claiming: Promise<unknown> | undefined;
    try {
      const old = await f.start("Original queued work");
      const worker = Object.create(WakeWorker.prototype) as WakeWorker;
      const internals = worker as unknown as {
        prisma: unknown;
        messaging: AgentMessaging;
        agentData: AgentDataStore;
        claim: (botId: string) => Promise<unknown>;
      };
      internals.messaging = f.messaging;
      internals.agentData = new AgentDataStore(db!, { root: "/tmp", workspaceRoot: "/tmp" });
      internals.prisma = {
        $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
          db!.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(target, property) {
                    if (property !== "inboxEvent") return Reflect.get(target, property);
                    return new Proxy(target.inboxEvent, {
                      get(delegate, method) {
                        if (method !== "findMany") return Reflect.get(delegate, method);
                        return async (args: Parameters<typeof delegate.findMany>[0]) => {
                          const candidates = await delegate.findMany(args);
                          if (args?.where?.deliveryMode === "turn") {
                            expect(
                              candidates.some((candidate) => candidate.runId === old.run.id)
                            ).toBe(true);
                            selected();
                            await gate;
                          }
                          return candidates;
                        };
                      },
                    });
                  },
                })
              ),
            { timeout: 15_000 }
          ),
      };
      claiming = internals.claim(old.run.botId);
      await selection;
      const replacement = await f.post("Replacement cancels selected work");
      release();
      expect(await claiming).toBeNull();
      expect((await db!.run.findUniqueOrThrow({ where: { id: old.run.id } })).status).toBe(
        "cancelled"
      );
      expect(
        (await db!.channelDelivery.findUniqueOrThrow({ where: { id: old.run.deliveryId! } })).status
      ).toBe("skipped");
      expect(await db!.botRunLease.count({ where: { runId: old.run.id } })).toBe(0);
      await f.messaging.advanceRound(replacement.round.id);
    } finally {
      release();
      await claiming?.catch(() => undefined);
      await f.cleanup();
    }
  },
  20_000
);

test.skipIf(!db)(
  "new group messages discard old buffered replies, skip old peers, and retain every user input",
  async () => {
    const f = await fixture();
    try {
      const old = await f.start("First request");
      await f.messaging.sendVisible(f.context(old.run), { type: "text", content: "obsolete" });
      const middle = await f.start("Second request");
      const latest = await f.start("@Beta Third request replaces prior work");
      expect((await db!.run.findUniqueOrThrow({ where: { id: old.run.id } })).status).toBe(
        "cancelled"
      );
      expect((await db!.run.findUniqueOrThrow({ where: { id: middle.run.id } })).status).toBe(
        "cancelled"
      );
      await expect(
        f.messaging.sendVisible(f.context(old.run), { type: "text", content: "late" })
      ).rejects.toThrow("no longer active");
      await f.messaging.completeDelivery(old.run.deliveryId!, "completed", undefined, old.run.id);
      await f.messaging.retryInterruptedGroupDelivery(old.run.deliveryId!, old.run.id);
      expect(
        await db!.channelMessage.count({ where: { channelId: f.channel.id, sender: "agent" } })
      ).toBe(0);
      expect(
        await db!.channelDelivery.count({
          where: { roundId: old.round.id, status: { not: "skipped" } },
        })
      ).toBe(0);
      expect(latest.run.botId).toBe(f.bots[1]!.id);
      const prompt = await db!.message.findUniqueOrThrow({
        where: { id: latest.run.userMessageId },
      });
      for (const text of ["First request", "Second request", "Third request"])
        expect(prompt.content).toContain(text);
      expect(f.cancelled.some((path) => path.includes(old.run.id))).toBe(true);
    } finally {
      await f.cleanup();
    }
  }
);

test.skipIf(!db)(
  "concurrent identical retries accept one root and do not supersede their own turn",
  async () => {
    const f = await fixture();
    try {
      const clientId = randomUUID();
      const accepted = await Promise.all(
        Array.from({ length: 6 }, () => f.post("One request", clientId))
      );
      expect(new Set(accepted.map((x) => x.message.id)).size).toBe(1);
      await f.messaging.advanceRound(accepted[0]!.round.id);
      const run = await f.runFor(accepted[0]!.message.id);
      expect(run.status).toBe("queued");
      expect(await db!.channelRound.count({ where: { channelId: f.channel.id } })).toBe(1);
      await expect(f.post("Different payload", clientId)).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  }
);

test.skipIf(!db)(
  "publication racing replacement is ordered before it or discarded, never posted stale afterward",
  async () => {
    for (let i = 0; i < 6; i++) {
      const f = await fixture();
      try {
        const old = await f.start("Original");
        await f.messaging.sendVisible(f.context(old.run), { type: "text", content: "race reply" });
        const [, latest] = await Promise.all([
          f.messaging.completeDelivery(old.run.deliveryId!, "completed", undefined, old.run.id),
          f.post("Replacement"),
        ]);
        const reply = await db!.channelMessage.findFirst({
          where: { channelId: f.channel.id, sender: "agent" },
        });
        if (reply) expect(reply.sequence < BigInt(latest.message.sequence)).toBe(true);
        await f.messaging.advanceRound(latest.round.id);
        expect((await f.runFor(latest.message.id)).status).toBe("queued");
      } finally {
        await f.cleanup();
      }
    }
  }
);

test.skipIf(!db)(
  "an independent system routine round is not cancelled by ordinary user conversation",
  async () => {
    const f = await fixture();
    try {
      const seed = await db!.channelMessage.create({
        data: { channelId: f.channel.id, sender: "system", content: "Saved routine work" },
      });
      const round = await db!.$transaction((tx) =>
        f.messaging.createGroupRound(tx, {
          channelId: f.channel.id,
          triggerMessageId: seed.id,
          initiatorBotId: null,
        })
      );
      await f.messaging.advanceRound(round.id);
      const routineRun = await f.runFor(seed.id);
      await f.start("New ordinary message");
      expect((await db!.run.findUniqueOrThrow({ where: { id: routineRun.id } })).status).toBe(
        "queued"
      );
      expect((await db!.channelRound.findUniqueOrThrow({ where: { id: round.id } })).status).toBe(
        "running"
      );
    } finally {
      await f.cleanup();
    }
  }
);
