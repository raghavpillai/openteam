import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ApiError } from "@openteam/contracts";
import { renderControlResult } from "@openteam/contracts/tool-results";
import { createPrismaClient } from "@openteam/db";
import { InternalToolService } from "../src/services/internal-tool-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("a channel send that cannot leave refuses at once; a failed delivery says why", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  let botId = "", channelId = "";
  try {
    const bot = await prisma.bot.create({
      data: { name: "Channel sends", status: "active", onboardingStatus: "completed", defaultDirectory: "/tmp", conversation: { create: {} } },
      include: { conversation: true },
    });
    botId = bot.id;
    channelId = (await prisma.channel.create({
      data: { kind: "bot_dm", name: "main", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } },
    })).id;
    const run = await prisma.run.create({
      data: { botId, conversationId: bot.conversation!.id, channelId, userMessageId: crypto.randomUUID(), status: "running" },
    });
    let failure: Error = new ApiError(400, "connected_channel_address_invalid", "Connected channel addresses must be shaped platform:chat");
    const wakes: string[] = [];
    const plugins = { deliverConnectedChannel: async () => { throw failure; } };
    const messaging = { enqueueChannelDeliveryFailure: async (_context: unknown, channel: string) => { wakes.push(channel); return "recovery-run"; } };
    const service = new InternalToolService(prisma, messaging as never, {} as never, async () => {}, {} as never, {} as never, {} as never, plugins as never);
    const send = (channel: string) => Effect.runPromise(service.execute({
      runId: run.id, botId, conversationId: bot.conversation!.id, channelId, deliveryId: null, tool: "SendToUser",
      arguments: { type: "text", content: "Hi", channel }, callId: crypto.randomUUID(),
    })) as Promise<any>;

    await expect(send("slackC123")).rejects.toThrow('"slackC123" is not a valid channel address, so nothing was sent. An address is shaped platform:chat.');
    failure = new ApiError(409, "connected_channel_unavailable", "No ready slack connection is connected");
    await expect(send("slack:C123")).rejects.toThrow("No ready slack connection is connected. Nothing was sent.");
    expect(wakes).toEqual([]);

    failure = new Error("channel_not_found");
    const failed = await send("slack:C123");
    expect(failed).toMatchObject({ sent: false, delivery_failed: true, reason: "channel_not_found" });
    expect(wakes).toEqual(["slack:C123"]);
    expect(renderControlResult("SendToUser", failed, { type: "text", channel: "slack:C123" })).toBe(
      "Message to slack:C123 was not delivered: channel_not_found. Tell the user it did not go through."
    );
  } finally {
    if (botId) await prisma.bot.deleteMany({ where: { id: botId } });
    if (channelId) await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.$disconnect();
  }
});
