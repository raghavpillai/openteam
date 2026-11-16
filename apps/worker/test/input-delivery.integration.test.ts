import { expect, test } from "bun:test";
import { Effect } from "effect";
import { databaseUrl, startStack } from "./fixtures/stack";

test.skipIf(!databaseUrl)("worker replays an unacknowledged user input and clears its watermark only after durable delivery", async () => {
  let failed = false;
  const stack = await startStack({
    truncate: true,
    async turn(input, call) {
      if (input.content.includes("This user input must survive") && !failed) {
        failed = true;
        return new Response("Synthetic pre-insertion interruption", { status: 503 });
      }
      await call("SendToUser", { type: "text", content: "Delivery fixture completed" }, `delivery:${input.runId}`);
    },
  });
  try {
    const { app } = stack;
    const run = (id: string) => app.prisma.run.findUnique({ where: { id } });
    const bot = await Effect.runPromise(app.createBot({ clientRequestId: crypto.randomUUID(), name: "Input fixture" }));
    const initial = (await Effect.runPromise(app.sendMessage(bot.conversationId, { content: "This user input must survive", clientId: "delivery-initial" }))) as any;
    await stack.until(async () => Boolean((await run(initial.run.id))?.inputDeliveredAt), "replayed input delivery");
    const replayed = (turn: (typeof stack.turns)[number]) => turn.prependMessages?.find((message) => message.id === "input:delivery-initial");
    const replay = stack.turns.find(replayed)!;
    expect(failed).toBe(true);
    expect(replayed(replay)?.content).toContain("This user input must survive");
    await stack.until(async () => (await run(replay.runId))?.status === "completed", "replay completion");
    const next = (await Effect.runPromise(app.sendMessage(bot.conversationId, { content: "After recovery", clientId: "delivery-followup" }))) as any;
    await stack.until(async () => (await run(next.run.id))?.status === "completed", "follow-up completion");
    expect(replayed(stack.turns.find((turn) => turn.runId === next.run.id)!)).toBeUndefined();
  } finally {
    await stack.close();
  }
}, 45_000);
