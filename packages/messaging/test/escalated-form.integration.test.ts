import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { AgentMessaging } from "../src";

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)("pending cards stop their own turn without blocking later replies or delegated results", async () => {
  const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
  const botId = crypto.randomUUID(), channelId = crypto.randomUUID(), conversationId = crypto.randomUUID(), runId = crypto.randomUUID();
  const messaging = new AgentMessaging(db, { send: async () => crypto.randomUUID(), sendDebounced: async () => crypto.randomUUID() } as never);
  try {
    await db.bot.create({ data: { id: botId, name: "Escalated form fixture", defaultDirectory: "/tmp", status: "active", conversation: { create: { id: conversationId } } } });
    await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Form fixture", members: { create: { botId, ordinal: 0 } } } });
    const input = await db.message.create({ data: { botId, conversationId, role: "user", content: "Help me", status: "completed" } });
    await db.run.create({ data: { id: runId, botId, channelId, conversationId, userMessageId: input.id, status: "running", origin: "user" } });
    const form = await db.channelMessage.create({ data: { channelId, sender: "agent", senderBotId: botId, sourceRunId: runId, content: "Sign in", metadata: { type: "user-form", cardState: "pending" } } });
    const context = { botId, channelId, conversationId, runId, deliveryId: null, origin: "user" as const, isFork: false, replyToMessageId: null };
    await expect(messaging.sendVisible({ ...context, callId: "pending" }, { type: "text", content: "Follow up" })).rejects.toThrow("already waiting");
    await db.channelMessage.update({ where: { id: form.id }, data: { metadata: { type: "user-form", cardState: "escalated", outcomeEchoed: true } } });
    expect((await messaging.sendVisible({ ...context, callId: "escalated" }, { type: "text", content: "The form moved to the screen." })).acknowledgement).toMatchObject({ sent: true });
    await db.channelMessage.update({ where: { id: form.id }, data: { metadata: { type: "user-form", cardState: "pending" } } });
    const followUp = await db.message.create({ data: { botId, conversationId, role: "user", content: "Why aren't you answering?", status: "completed" } });
    const followUpRun = await db.run.create({ data: { botId, channelId, conversationId, userMessageId: followUp.id, status: "running", origin: "user" } });
    const followUpContext = { ...context, runId: followUpRun.id };
    expect((await messaging.sendVisible({ ...followUpContext, callId: "new-user-reply" }, { type: "text", content: "I can answer while the sign-in form is pending." })).acknowledgement).toMatchObject({ sent: true });
    expect((await db.channelMessage.findUnique({ where: { id: form.id } }))?.metadata).toMatchObject({ cardState: "pending" });
    for (const origin of ["background_revival", "handoff_resume"] as const) {
      const completionInput = await db.message.create({ data: { botId, conversationId, role: "user", content: "The requested page inspection finished.", status: "completed" } });
      const completionRun = await db.run.create({ data: { botId, channelId, conversationId, userMessageId: completionInput.id, status: "running", origin } });
      const completionContext = { ...context, origin, runId: completionRun.id };
      expect((await messaging.sendVisible({ ...completionContext, callId: origin }, { type: "text", content: "Google's session expired. The check is complete.", end_turn: true })).acknowledgement).toMatchObject({ sent: true });
    }
    expect((await db.channelMessage.findUnique({ where: { id: form.id } }))?.metadata).toMatchObject({ cardState: "pending" });
    expect((await messaging.sendVisible({ ...followUpContext, callId: "new-question" }, { type: "widget", widget: { prompt: "Another question", options: [{ label: "Alpha", value: "alpha" }] } })).acknowledgement).toMatchObject({ sent: true });
    await expect(messaging.sendVisible({ ...followUpContext, callId: "after-own-question" }, { type: "text", content: "This turn must stop after its own question." })).rejects.toThrow("already waiting");
  } finally {
    await db.channel.deleteMany({ where: { id: channelId } });
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
  }
});
