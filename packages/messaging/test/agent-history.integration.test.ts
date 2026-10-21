import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { readAgentActivity } from "../src/read-agent-activity";
import { readTranscript } from "../src/read-transcript";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!url)("workers read no transcripts; activity covers the user's other recent bots", async () => {
  const db = createPrismaClient(url!);
  const botIds: string[] = [];
  const channelIds: string[] = [];
  const bot = async (name: string, description = "") => {
    const created = await db.bot.create({ data: { name, description, status: "active", defaultDirectory: "/tmp/worker-history", conversation: { create: {} } }, include: { conversation: true } });
    botIds.push(created.id);
    return created;
  };
  const mainChat = async (botId: string) => {
    const channel = await db.channel.create({ data: { kind: "bot_dm", name: "main", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
    channelIds.push(channel.id);
    return channel;
  };
  try {
    const parent = await bot("Parent fixture");
    const parentChat = await mainChat(parent.id);
    await db.channelMessage.create({ data: { channelId: parentChat.id, sender: "user", content: "PARENT_MAIN_CHAT" } });
    const ask = await db.message.create({ data: { botId: parent.id, conversationId: parent.conversation!.id, role: "user", content: "fixture" } });
    const parentRun = await db.run.create({ data: { botId: parent.id, conversationId: parent.conversation!.id, userMessageId: ask.id, channelId: parentChat.id, status: "running" } });
    const worker = async (subagentType: string) => {
      const child = await bot(`${subagentType} worker`);
      await db.subagent.create({ data: { parentBotId: parent.id, childBotId: child.id, parentRunId: parentRun.id, parentChannelId: parentChat.id, launchCallId: crypto.randomUUID(), description: "fixture", prompt: "WORKER_TASK", subagentType, outputPath: "/tmp/unused", status: "running" } });
      const task = await db.message.create({ data: { botId: child.id, conversationId: child.conversation!.id, role: "user", content: `${subagentType}_TASK` } });
      await db.run.create({ data: { botId: child.id, conversationId: child.conversation!.id, userMessageId: task.id, status: "running" } });
      return child;
    };
    const knowledge = await worker("knowledgeWork");
    const executor = await worker("executor");
    const graphical = await worker("computerUse");

    const peer = await bot("Peer fixture", "Tracks the hiring plan.");
    const peerChat = await mainChat(peer.id);
    await db.channelMessage.create({ data: { channelId: peerChat.id, sender: "user", content: "PEER_VISIBLE", createdAt: new Date(Date.now() - 3_600_000) } });
    await db.channelMessage.create({ data: { channelId: peerChat.id, sender: "agent", senderBotId: peer.id, content: "Draft is ready. Should I send it to Dana?" } });
    await db.todoItem.createMany({ data: [
      { botId: peer.id, id: "t1", content: "Send the hiring plan", status: "in_progress", position: 0 },
      { botId: peer.id, id: "t2", content: "DONE_TODO", status: "completed", position: 1 },
    ] });
    const stale = await bot("Stale fixture");
    const staleChat = await mainChat(stale.id);
    await db.channelMessage.create({ data: { channelId: staleChat.id, sender: "user", content: "STALE", createdAt: new Date(Date.now() - 10 * 86_400_000) } });

    // The parent passes a worker what it needs; workers read no transcripts, not even their own run or a peer's.
    for (const child of [knowledge, executor, graphical]) {
      await expect(readTranscript(db, { botId: child.id, channelId: null }, {})).rejects.toThrow("not available");
      await expect(readTranscript(db, { botId: child.id, channelId: null }, { in: peer.id })).rejects.toThrow("not available");
    }
    expect(JSON.stringify(await readTranscript(db, { botId: parent.id, channelId: null }, { in: peer.id }))).toContain("PEER_VISIBLE");

    // Activity covers the user's other bots, not the asking bot, and only recent ones.
    const activity = await readAgentActivity(db, { botId: parent.id }, { since_hours: 72 });
    expect(activity).toContain(`## Peer fixture (agent ${peer.id})`);
    expect(activity).toContain("Tracks the hiring plan.");
    expect(activity).toContain("Open todos (1):\n- [in_progress] Send the hiring plan");
    expect(activity).not.toContain("DONE_TODO");
    expect(activity).toContain("Pending questions (1):");
    expect(activity).toContain("Should I send it to Dana?");
    expect(activity).toContain("User: PEER_VISIBLE\nPeer fixture: Draft is ready. Should I send it to Dana?");
    expect(activity).not.toContain("Parent fixture (agent");
    expect(activity).not.toContain("Stale fixture");
    expect(activity).not.toContain("worker (agent");
  } finally {
    await db.bot.deleteMany({ where: { id: { in: botIds } } });
    await db.channel.deleteMany({ where: { id: { in: channelIds } } });
    await db.$disconnect();
  }
}, 20_000);
