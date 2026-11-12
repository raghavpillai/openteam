import { describe, expect, test } from "bun:test";
import { postgresJson, postgresText } from "../src/postgres-json";
import { Projection } from "../src/projection";

test("projection text is PostgreSQL safe while retaining valid Unicode and literal escapes",()=>{
  expect(postgresText("a\0b\ud800c\udc00 🌍 \\u0000")).toBe("a�b�c� 🌍 \\u0000");
  expect(postgresJson({"k\0": ["v\0",null,42]})).toEqual({"k�":["v�",null,42]});
});

test("a tool result containing binary text does not pass NUL to projection storage",async()=>{
  const writes:any[]=[];
  const tx={runItem:{upsert:async(x:any)=>{writes.push(x);return {id:"item"}}},event:{create:async()=>({})}};
  const p=new Projection({$transaction:async(fn:any)=>fn(tx)} as never);
  await p.apply("run","conversation","bot",{type:"item.completed",turnId:"run",item:{id:"tool",type:"dynamicToolCall",tool:"Read",status:"completed",result:{content:[{type:"text",text:"before\0after"}]}}} as any);
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(writes)).toContain("before�after");
  expect(JSON.stringify(writes)).not.toContain("\\u0000");
});

describe("context compaction projection", () => {
  test("reconciles exact archive epochs and projects stable compaction ids idempotently", async () => {
    const botId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const contextSessionId = crypto.randomUUID();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const context = {
      id: contextSessionId,
      botId,
      scope: "home",
      scopeId: conversationId,
      compactionEpoch: 0,
      lastArchiveId: null as string | null,
    };
    const compactions = new Map<string, Record<string, unknown>>();
    const events: Array<Record<string, unknown>> = [];
    let conversationEpoch = 0;
    const tx = {
      contextSession: {
        findUniqueOrThrow: async () => ({ ...context }),
        update: async ({ data }: { data: Partial<typeof context> }) => {
          Object.assign(context, data);
          return { ...context };
        },
      },
      contextCompaction: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          compactions.get(where.id) ?? null,
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const current = compactions.get(where.id);
          const next = current ? { ...current, ...update } : { ...create };
          compactions.set(where.id, next);
          return next;
        },
        updateMany: async () => ({ count: 0 }),
      },
      conversation: {
        update: async ({ data }: { data: { compactionEpoch: number } }) => {
          conversationEpoch = data.compactionEpoch;
          return { id: conversationId, compactionEpoch: conversationEpoch };
        },
      },
      event: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          events.push(data);
          return data;
        },
      },
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    };
    const projection = new Projection(prisma as never);
    const archive = {
      id: firstId,
      sequence: 1,
      reason: "approaching_token_limit",
      prefixDigest: "a".repeat(64),
      summaryDigest: "b".repeat(64),
      tokensBefore: 95_000,
      tokensAfter: 2_000,
      imageCount: 0,
      turnCount: 42,
      startedAt: new Date(1).toISOString(),
      completedAt: new Date(2).toISOString(),
    };
    await projection.apply("run-1", conversationId, botId, {
      type: "context.state",
      contextSessionId,
      epoch: 1,
      archives: [archive],
    });
    expect(context.compactionEpoch).toBe(1);
    expect(conversationEpoch).toBe(1);
    expect(compactions.has(firstId)).toBe(true);

    const second = {
      type: "compaction" as const,
      turnId: "turn-1",
      contextSessionId,
      compactionId: secondId,
      epoch: 2,
      reason: "fallback_on_limit_error",
      prefixDigest: "c".repeat(64),
      summaryDigest: "d".repeat(64),
      tokensBefore: 100_000,
      tokensAfter: 3_000,
      imageCount: 2,
      turnCount: 43,
      startedAt: new Date(3).toISOString(),
      completedAt: new Date(4).toISOString(),
    };
    await projection.apply("run-1", conversationId, botId, second);
    await projection.apply("run-1", conversationId, botId, second);
    expect(context.compactionEpoch).toBe(2);
    expect(context.lastArchiveId).toBe(secondId);
    expect(conversationEpoch).toBe(2);
    expect(compactions.size).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      topic: "conversation.compacted",
      entityId: conversationId,
    });
  });
});

type Delivery = {
  deliveryKey: string;
  payload: Record<string, unknown>;
};

const notificationProjection = ({
  initialStatus = "running",
  lastMessage = { content: "Finished output", metadata: null },
  originChannelKind = "bot_dm",
}: {
  initialStatus?: string;
  lastMessage?: { content: string; metadata: unknown } | null;
  originChannelKind?: "bot_dm" | "group";
} = {}) => {
  let status = initialStatus;
  const deliveries: Delivery[] = [];
  const bot = {
    id: "bot-1",
    name: "Probe",
    notificationsEnabled: true,
    hiddenFromSidebar: false,
  };
  const channel = { id: "channel-1", kind: "bot_dm", archivedAt: null };
  const originChannel = {
    id: originChannelKind === "group" ? "group-1" : channel.id,
    kind: originChannelKind,
    archivedAt: null,
  };
  const keys = new Set<string>();
  const tx = {
    $executeRaw: async () => 1,
    bot: { findUnique: async () => bot },
    channelNotification: {
      createMany: async ({ data }: { data: { key: string } }) => {
        const count = keys.has(data.key) ? 0 : 1;
        keys.add(data.key);
        return { count };
      },
      findUniqueOrThrow: async () => ({ sequence: BigInt(keys.size) }),
    },
    $queryRaw: async () => [{ count: 0n }],
    run: {
      findUniqueOrThrow: async () => ({ status }),
      findUnique: async () => ({ bot, channel: originChannel }),
      update: async ({ data }: { data: { status?: string } }) => {
        if (data.status) status = data.status;
        return { status };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { status: { in: string[] } };
        data: { status: string };
      }) => {
        if (!where.status.in.includes(status)) return { count: 0 };
        status = data.status;
        return { count: 1 };
      },
    },
    runItem: {
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    approval: {
      upsert: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    message: { updateMany: async () => ({ count: 0 }) },
    event: { create: async () => ({}) },
    channelMessage: {
      findFirst: async () =>
        lastMessage
          ? {
              id: "message-1",
              sequence: 10n,
              channelId: channel.id,
              senderBotId: bot.id,
              sourceRunId: "run-1",
              ...lastMessage,
            }
          : null,
      findMany: async () => [],
    },
    channel: {
      findUnique: async () => channel,
      findFirst: async () => channel,
      findMany: async () => [],
    },
    pushDevice: { findMany: async () => [{ id: "device-1" }] },
    outboxDelivery: {
      createMany: async ({ data }: { data: Delivery[] }) => {
        deliveries.push(...data);
        return { count: data.length };
      },
    },
  };
  const prisma = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  };
  return {
    projection: new Projection(prisma as never),
    deliveries,
    status: () => status,
  };
};

describe("OpenTeam-compatible notification transitions", () => {

  test("a cancelled run still notifies when it produced a new bot message", async () => {
    const harness = notificationProjection({ initialStatus: "cancelled" });

    await harness.projection.apply("run-1", "conversation-1", "bot-1", {
      type: "turn.completed",
      turnId: "turn-1",
      status: "interrupted",
    });

    expect(harness.status()).toBe("cancelled");
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]?.payload).toMatchObject({
      kind: "message",
      runId: "run-1",
    });
  });

  test("a group-origin run notifies only through the bot's private home message", async () => {
    const harness = notificationProjection({ originChannelKind: "group" });

    await harness.projection.apply("run-1", "conversation-1", "bot-1", {
      type: "turn.completed",
      turnId: "turn-1",
      status: "completed",
    });

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]?.payload).toMatchObject({
      kind: "message",
      channelId: "channel-1",
    });
  });

  test("a terminal run without a bot message does not notify", async () => {
    const harness = notificationProjection({ initialStatus: "cancelled", lastMessage: null });

    await harness.projection.apply("run-1", "conversation-1", "bot-1", {
      type: "turn.completed",
      turnId: "turn-1",
      status: "interrupted",
    });

    expect(harness.deliveries).toHaveLength(0);
  });
});
