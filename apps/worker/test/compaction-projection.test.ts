import { describe, expect, test } from "bun:test";
import { Projection } from "../src/projection";

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
