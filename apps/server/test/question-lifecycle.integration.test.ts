import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging, type ToolContext } from "@openteam/messaging";
import { RichMessageService } from "../src/services/rich-message-service";
import { ChannelService } from "../src/services/channel-service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!url)(
  "questions settle durably across normal sends, publication, retries, forks and races",
  async () => {
    const db = createPrismaClient(url!);
    const root = await mkdtemp(join(tmpdir(), "question-lifecycle-"));
    const botId = crypto.randomUUID(),
      channelId = crypto.randomUUID();
    const data = new AgentDataStore(db, { root, workspaceRoot: root });
    const messaging = new AgentMessaging(
      db,
      { send: async () => null, sendDebounced: async () => null } as never,
      data
    );
    const rich = new RichMessageService(db, messaging, {} as never, {} as never);
    const channels = new ChannelService(db, messaging, root, async () => new Response(null));
    const widget = {
      prompt: "Which color?",
      options: [
        { label: "Blue", value: "blue" },
        { label: "Red", value: "red" },
      ],
      allowCustom: true,
    };
    try {
      const bot = await db.bot.create({
        data: {
          id: botId,
          name: "Question lifecycle",
          status: "active",
          onboardingStatus: "completed",
          defaultDirectory: root,
          conversation: { create: {} },
        },
        include: { conversation: true },
      });
      const conversationId = bot.conversation!.id;
      await db.channel.create({
        data: {
          id: channelId,
          kind: "bot_dm",
          name: "QA",
          directKey: `bot:${botId}`,
          members: { create: { botId, ordinal: 0 } },
        },
      });
      await data.initializeBot(botId);
      await data.writeRootSettings({});
      const card = (metadata = {}) =>
        db.channelMessage.create({
          data: {
            channelId,
            sender: "agent",
            senderBotId: botId,
            content: widget.prompt,
            metadata: { type: "widget", widget, ...metadata },
          },
        });
      const read = async (id: string) =>
        (await db.channelMessage.findUniqueOrThrow({ where: { id } })).metadata as Record<
          string,
          unknown
        >;
      const send = (content: string, extra = {}) =>
        Effect.runPromise(
          channels.sendDirectMessage(conversationId, {
            content,
            clientId: crypto.randomUUID(),
            attachments: [],
            ...extra,
          })
        );
      const first = await card();
      const branch = await card({ branched: true, questionScopeId: first.id });
      const approval = await db.channelMessage.create({
        data: {
          channelId,
          sender: "agent",
          senderBotId: botId,
          content: "Review only",
          metadata: { type: "external-draft", cardState: "pending" },
        },
      });
      const input = { content: "Blue", clientId: crypto.randomUUID(), attachments: [] };
      await Effect.runPromise(channels.sendDirectMessage(conversationId, input));
      expect(await read(first.id)).toMatchObject({
        widgetDismissed: true,
        widgetDismissalReason: "moved-on",
      });
      expect(await read(first.id)).not.toHaveProperty("respondedValue");
      expect(await read(branch.id)).not.toHaveProperty("widgetDismissed");
      expect(await read(approval.id)).toMatchObject({ cardState: "pending" });
      expect(
        (
          await Effect.runPromise(
            rich.respondToWidget(first.id, { value: "red", clientId: crypto.randomUUID() })
          )
        ).accepted
      ).toBe(false);
      expect(await db.inboxEvent.count({ where: { botId, type: "widget.response" } })).toBe(0);
      const later = await card();
      await expect(send("Invalid fork", { isFork: true })).rejects.toThrow(
        "A fork needs a reply target"
      );
      expect(await read(later.id)).not.toHaveProperty("widgetDismissed");
      await Effect.runPromise(channels.sendDirectMessage(conversationId, input));
      expect(await read(later.id)).not.toHaveProperty("widgetDismissed"); // retry isn't a newer message
      await send("Thread answer", { replyToMessageId: first.id, isFork: true });
      expect(await read(branch.id)).toHaveProperty("widgetDismissed", true);
      expect(await read(later.id)).not.toHaveProperty("widgetDismissed");
      const answered = await Effect.runPromise(
        rich.respondToWidget(later.id, { value: "blue", clientId: crypto.randomUUID() })
      );
      expect(answered.accepted).toBe(true);
      await send("Another topic");
      expect(await read(later.id)).toHaveProperty("respondedValue", "blue");

      // A fresh card retires an earlier pending card but a repeated tool call does not retire itself.
      const pending = await card();
      const run = await db.run.create({
        data: {
          botId,
          conversationId,
          channelId,
          userMessageId: crypto.randomUUID(),
          status: "running",
        },
      });
      const context: ToolContext = {
        botId,
        channelId,
        conversationId,
        runId: run.id,
        origin: "user",
        deliveryId: null,
        callId: crypto.randomUUID(),
        replyToMessageId: null,
        isFork: false,
      };
      const visible = await messaging.sendVisible(context, { type: "widget", widget });
      const id = (visible.acknowledgement as { message_id: string }).message_id;
      expect(await read(pending.id)).toMatchObject({
        widgetDismissed: true,
        widgetDismissalReason: "superseded",
      });
      await messaging.sendVisible(context, { type: "widget", widget });
      expect(await read(id)).not.toHaveProperty("widgetDismissed");
      await Effect.runPromise(rich.dismissWidget(id, { clientId: crypto.randomUUID() }));
      expect(await read(id)).toHaveProperty("widgetDismissalReason", "dismissed");
      expect(await db.inboxEvent.count({ where: { botId, type: "widget.response" } })).toBe(1);

      for (let attempt = 0; attempt < 8; attempt++) {
        const q = await card();
        const [response] = await Promise.all([
          Effect.runPromise(
            rich.respondToWidget(q.id, { value: "blue", clientId: crypto.randomUUID() })
          ),
          send("Move on"),
        ]);
        const metadata = await read(q.id);
        expect(
          (typeof metadata.respondedValue === "string") !== (metadata.widgetDismissed === true)
        ).toBe(true);
        expect(response.accepted).toBe(metadata.respondedValue === "blue");
      }
      expect(
        await db.event.count({ where: { entityId: first.id, topic: "channel.message.updated" } })
      ).toBe(1);
      const visibleUser = await db.channelMessage.findUniqueOrThrow({
        where: { channelId_clientId: { channelId, clientId: input.clientId } },
      });
      expect(visibleUser.content).toBe("Blue");
      expect(visibleUser.sender).toBe("user");
    } finally {
      await db.bot.deleteMany({ where: { id: botId } });
      await db.channel.deleteMany({ where: { id: channelId } });
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000
);
