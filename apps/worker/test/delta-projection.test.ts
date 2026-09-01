import { expect, test } from "bun:test";
import { Projection } from "../src/projection";

test("agent deltas append in SQL without emitting a global event per token", async () => {
  const statements: string[] = [];
  const eventCreates: unknown[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      statements.push(strings.join("?"));
      return 1;
    },
    runItem: { upsert: async () => ({}) },
    event: {
      create: async (input: unknown) => {
        eventCreates.push(input);
        return {};
      },
    },
  };
  let transactions = 0;
  const prisma = {
    $executeRaw: tx.$executeRaw,
    $transaction: async (work: (client: typeof tx) => Promise<void>) => {
      transactions += 1;
      return work(tx);
    },
  };

  await new Projection(prisma as never).apply("run-1", "conversation-1", "bot-1", {
    type: "agent.delta",
    turnId: "turn-1",
    itemId: "item-1",
    delta: "hello",
  });

  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('"Message"."content" || EXCLUDED."content"');
  expect(statements[0]).toContain("ON CONFLICT");
  expect(statements[0]).toContain('WHERE "Message"."status" <> \'completed\'::"MessageStatus"');
  expect(eventCreates).toHaveLength(0);
  expect(transactions).toBe(0);
});
