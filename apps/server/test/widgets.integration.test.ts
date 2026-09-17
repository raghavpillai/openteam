import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging } from "@openteam/messaging";
import { RichMessageService } from "../src/services/rich-message-service";
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "widget races settle once, duplicates return the winner, dismissal settles without waking, archived cards reject",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const root = await mkdtemp(join(tmpdir(), "widget-permission-"));
    const botId = crypto.randomUUID(),
      channelId = crypto.randomUUID(),
      conversationId = crypto.randomUUID();
    const data = new AgentDataStore(prisma, { root: join(root, "data"), workspaceRoot: root });
    const messaging = new AgentMessaging(
      prisma,
      {
        send: async () => crypto.randomUUID(),
        sendDebounced: async () => crypto.randomUUID(),
      } as never,
      data
    );
    const service = new RichMessageService(prisma, messaging, {} as never, {} as never);
    const widget = {
      prompt: "Choose a route",
      options: [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
      ],
      allowCustom: false,
    };
    try {
      await prisma.bot.create({
        data: {
          id: botId,
          name: "Widget fixture",
          defaultDirectory: root,
          status: "active",
          onboardingStatus: "completed",
          conversation: { create: { id: conversationId } },
        },
      });
      await prisma.channel.create({
        data: {
          id: channelId,
          kind: "bot_dm",
          name: "Widget fixture",
          directKey: `bot:${botId}`,
          members: { create: { botId, ordinal: 0 } },
        },
      });
      await data.initializeBot(botId);
      await data.writeRootSettings({});
      const create = () =>
        prisma.channelMessage.create({
          data: {
            channelId,
            sender: "agent",
            senderBotId: botId,
            content: widget.prompt,
            metadata: { type: "widget", widget },
          },
        });
      const first = await create();
      const results = await Promise.all(
        ["alpha", "beta"].map((value) =>
          Effect.runPromise(
            service.respondToWidget(first.id, { value, clientId: crypto.randomUUID() })
          )
        )
      );
      expect(results.filter((result) => result.accepted)).toHaveLength(1);
      const winner = (results.find((result) => result.accepted)!.message.metadata as any)
        .respondedValue;
      expect(
        results.every((result) => (result.message.metadata as any).respondedValue === winner)
      ).toBe(true);
      expect(await prisma.inboxEvent.count({ where: { botId, type: "widget.response" } })).toBe(1);
      expect(
        (
          await Effect.runPromise(
            service.dismissWidget(first.id, { clientId: crypto.randomUUID() })
          )
        ).accepted
      ).toBe(false);
      const second = await create();
      await expect(
        Effect.runPromise(
          service.respondToWidget(second.id, { value: "invalid", clientId: crypto.randomUUID() })
        )
      ).rejects.toThrow();
      expect(
        (await prisma.channelMessage.findUniqueOrThrow({ where: { id: second.id } })).metadata
      ).not.toHaveProperty("respondedValue");
      const dismissed = await Promise.all(
        [1, 2].map(() =>
          Effect.runPromise(service.dismissWidget(second.id, { clientId: crypto.randomUUID() }))
        )
      );
      expect(dismissed.filter((result) => result.accepted)).toHaveLength(1);
      expect(
        dismissed.every((result) => (result.message.metadata as any).widgetDismissed === true)
      ).toBe(true);
      const third = await create();
      await prisma.channel.update({ where: { id: channelId }, data: { archivedAt: new Date() } });
      await expect(
        Effect.runPromise(
          service.respondToWidget(third.id, { value: "alpha", clientId: crypto.randomUUID() })
        )
      ).rejects.toThrow("Live widget not found");
      expect(await prisma.inboxEvent.count({ where: { botId, type: "widget.response" } })).toBe(1);
    } finally {
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.channel.deleteMany({ where: { id: channelId } });
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  }
);
