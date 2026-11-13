import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { readAgentActivity } from "../src/read-agent-activity";
import { readTranscript } from "../src/read-transcript";
import { listSiblingThreads, renderOtherActiveConversations, type SiblingThread } from "../src/sibling-threads";

// Transcript and cross-conversation access: who may read which persisted history.
const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = test.skipIf(!url);
let db: ReturnType<typeof createPrismaClient>;
const botIds: string[] = [];
const channelIds: string[] = [];
beforeAll(() => { if (url) db = createPrismaClient(url); });
afterAll(async () => {
  if (!url) return;
  await db.channel.deleteMany({ where: { id: { in: channelIds } } });
  await db.bot.deleteMany({ where: { id: { in: botIds } } });
  await db.$disconnect();
});
const track = (id: string) => (channelIds.push(id), id);
const bot = async (name = "Transcript fixture", description = "") => {
  const created = await db.bot.create({ data: { name, description, status: "active", defaultDirectory: "/tmp/transcript-fixture", conversation: { create: {} } }, include: { conversation: true } });
  botIds.push(created.id);
  return created;
};
const mainChat = async (botId: string) => {
  const channel = await db.channel.create({ data: { kind: "bot_dm", name: "main", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
  track(channel.id);
  return channel;
};

integration("scoped persisted history: stopped workers, paging, append, compaction and private boundaries", async () => {
  const parent=await bot(), child=await bot(), foreign=await bot();
  const channel=await db.channel.create({data:{kind:'bot_dm',name:'Transcript QA',members:{create:{botId:parent.id,ordinal:0}}}});track(channel.id);
  const session=await db.contextSession.create({data:{botId:parent.id,scope:'channel',scopeId:channel.id,compactionEpoch:3}});
  const context={botId:parent.id,channelId:channel.id};
  await db.channelMessage.create({data:{channelId:channel.id,sender:'user',content:'PRE_COMPACTION_VISIBLE'}});
  await db.channelMessage.create({data:{channelId:channel.id,sender:'system',content:'DO_NOT_EXPOSE_SYSTEM'}});
  expect((await readTranscript(db,context,{})).rows.map(r=>r.content)).toEqual(['PRE_COMPACTION_VISIBLE']);
  expect((await readTranscript(db,context,{in:session.id})).total).toBe(1);
  // The agent's own id reads every one of its conversations, as a routine run does for its parent.
  expect((await readTranscript(db,{botId:parent.id,channelId:null},{in:parent.id})).total).toBe(1);
  await expect(readTranscript(db,context,{in:crypto.randomUUID()})).rejects.toThrow('not available');
  await expect(readTranscript(db,context,{in:'not-an-id'})).rejects.toThrow('not available');
  const user=await db.message.create({data:{botId:parent.id,conversationId:parent.conversation!.id,role:'user',content:'fixture'}});
  const parentRun=await db.run.create({data:{botId:parent.id,conversationId:parent.conversation!.id,userMessageId:user.id,channelId:channel.id,status:'completed'}});
  const worker=await db.subagent.create({data:{parentBotId:parent.id,childBotId:child.id,parentRunId:parentRun.id,parentChannelId:channel.id,launchCallId:crypto.randomUUID(),description:'fixture',prompt:'PUBLIC_TASK',subagentType:'executor',outputPath:'/tmp/unused',status:'stopped'}});
  const task=await db.message.create({data:{botId:child.id,conversationId:child.conversation!.id,role:'user',content:'PUBLIC_TASK',createdAt:new Date('2026-01-01')}});
  const run=await db.run.create({data:{botId:child.id,conversationId:child.conversation!.id,userMessageId:task.id,status:'interrupted'}});
  await db.runItem.create({data:{runId:run.id,kind:'tool',title:'promptFingerprint',content:{private:'PRIVATE_BOOTSTRAP_METADATA'}}});
  await db.runItem.create({data:{runId:run.id,kind:'reasoning',content:{text:'PRIVATE_REASONING'}}});
  await db.runItem.create({data:{runId:run.id,kind:'command',status:'completed',content:{type:'commandExecution',command:'echo hello',result:{content:[{type:'text',text:'hello'}]}},createdAt:new Date('2026-01-02')}});
  await db.message.create({data:{botId:child.id,conversationId:child.conversation!.id,role:'system',content:'PRIVATE_BOOTSTRAP'}});
  const target={in:`sand-subagent-${worker.id}`};
  const page=await readTranscript(db,context,{...target,limit:1});
  expect(page.total).toBe(2);expect(page.next_before).toBe(1);expect(page.rows[0]!.content).toContain('hello');
  await db.message.create({data:{botId:child.id,conversationId:child.conversation!.id,role:'assistant',content:'APPENDED'}});
  const previous=await readTranscript(db,context,{...target,limit:1,before:page.next_before});
  expect(previous.rows[0]!.content).toBe('PUBLIC_TASK');expect(previous.next_before).toBeNull();
  expect((await readTranscript(db,context,{...target,before:0})).rows).toEqual([]);
  await db.runItem.updateMany({where:{runId:run.id,kind:'command'},data:{content:{type:'commandExecution',command:'print diagnostic',result:{content:[{type:'text',text:'BEGIN\nPASSWORD=fixture-secret\n'+'record\n'.repeat(6000)+'\nFINAL_RESULT=complete'}],details:{exitCode:0}}}}});
  const expanded=await readTranscript(db,context,{...target,limit:1,before:2});
  expect(expanded.rows[0]!.content).toContain('FINAL_RESULT=complete');
  expect(expanded.rows[0]!.content).toContain('print diagnostic');
  expect(expanded.rows[0]!.content).not.toContain('fixture-secret');
  expect(expanded.rows[0]!.content.length).toBeGreaterThan(20_000);
  expect(expanded.rows[0]!.content.length).toBeLessThan(20_100);
  await db.message.createMany({data:Array.from({length:30},(_,i)=>({botId:child.id,conversationId:child.conversation!.id,role:'assistant' as const,content:`row ${i}: `+'detail '.repeat(800)}))});
  const bounded=await readTranscript(db,context,{...target,limit:200});
  expect(bounded.rows[1]!.content).toContain('FINAL_RESULT=complete');
  expect(bounded.rows[1]!.content.length).toBeLessThan(2000);
  expect(bounded.rows.reduce((n,r)=>n+r.content.length,0)).toBeLessThan(63_000);
  await db.runItem.create({data:{runId:run.id,kind:'tool',status:'completed',content:{tool:'Computer',arguments:{action:'type',text:'PRIVATE_TYPED_INPUT'},result:{content:[{type:'text',text:'Screenshot saved to /workspace/shared/screenshots/stopped-worker.png'},{type:'image',data:'PRIVATE_IMAGE'}]}}}});
  const recovered=await readTranscript(db,context,{...target,limit:200});
  expect(recovered.rows.some(r=>r.content.includes('/workspace/shared/screenshots/stopped-worker.png'))).toBe(true);
  expect(JSON.stringify(recovered)).not.toContain('PRIVATE_TYPED_INPUT');
  expect(JSON.stringify(recovered)).not.toContain('PRIVATE_IMAGE');
  expect(JSON.stringify(await readTranscript(db,context,target))).not.toContain('PRIVATE_');
  await expect(readTranscript(db,{botId:foreign.id,channelId:channel.id},target)).rejects.toThrow('not available');
  await expect(readTranscript(db,{botId:child.id,channelId:null},{in:parent.id})).rejects.toThrow('not available');
  await expect(readTranscript(db,{botId:foreign.id,channelId:channel.id},{in:session.id})).rejects.toThrow('not available');
  await expect(readTranscript(db,context,{in:child.id})).rejects.toThrow('not available');
  // Peer reads retain the existing visible-message policy, never peer tool payloads.
  await db.runItem.create({data:{runId:parentRun.id,kind:'command',content:{type:'commandExecution',command:'PEER_PRIVATE_COMMAND'}}});
  const peer=await readTranscript(db,{botId:foreign.id,channelId:null},{in:parent.id});
  expect(peer.total).toBe(1);expect(JSON.stringify(peer)).not.toContain('PEER_PRIVATE');
  await db.channel.update({where:{id:channel.id},data:{archivedAt:new Date()}});
  await expect(readTranscript(db,context,{})).rejects.toThrow('not available');
}, 20_000);

integration("workers read no transcripts; activity covers the user's other recent bots", async () => {
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
}, 20_000);

const thread = (sessionId: string, lastActivityAt: Date): SiblingThread =>
  ({ sessionId, channelId: `channel-${sessionId}`, name: `Room ${sessionId}`, kind: "group chat", lastActivityAt });

test("other active conversations list recent sessions for ReadTranscript, bounded and in id order", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const day = 24 * 60 * 60 * 1_000;
  const threads = [
    ...Array.from({ length: 10 }, (_, index) => thread(`s${9 - index}`, new Date(now - index * day))),
    thread("stale", new Date(now - 15 * day)),
  ];
  const rendered = renderOtherActiveConversations(threads, now).split("\n");
  expect(rendered.slice(0, 3)).toEqual([
    "## Other active conversations",
    "Other active conversations: this agent also has separate conversations running in parallel.",
    "Use ReadTranscript with in=<session_id> to inspect another conversation's transcript when you need cross-conversation context.",
  ]);
  // The eight most recent, listed by session id; the two older ones are counted, the stale one dropped.
  expect(rendered.slice(3, 11)).toEqual(["s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"].map((id) =>
    `- Room ${id}, session_id: ${id} (group chat, last active ${new Date(now - (9 - Number(id.slice(1))) * day).toISOString().slice(0, 10)})`
  ));
  expect(rendered[11]).toBe("(2 older conversations not listed.)");
  expect(rendered).toHaveLength(12);
  expect(renderOtherActiveConversations([thread("stale", new Date(now - 15 * day))], now)).toBe("");
});

integration("other conversations list visible sessions that ReadTranscript reads, never the current, archived, left or agent-to-agent ones", async () => {
    const botId=(await bot()).id, peerId=(await bot()).id;
    const ids=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()].map(track);
    for(const id of ids.slice(0,2))await db.channel.create({data:{id,kind:"group",name:`Room ${id}`,members:{create:{botId,ordinal:0}}}});
    await db.channel.create({data:{id:ids[2]!,kind:"agent_dm",name:"Peer DM",members:{create:[{botId,ordinal:0},{botId:peerId,ordinal:1}]}}});
    const current=await db.contextSession.create({data:{botId,scope:"channel",scopeId:ids[0]!}});
    const sibling=await db.contextSession.create({data:{botId,scope:"channel",scopeId:ids[1]!}});
    await db.contextSession.create({data:{botId,scope:"channel",scopeId:ids[2]!}});
    // Distinct times: rows written in the same millisecond have no defined transcript order.
    const sentAt=Date.now();
    for(let i=1;i<=3;i++)await db.channelMessage.create({data:{channelId:ids[1]!,sender:i%2?"user":"agent",senderBotId:i%2?null:botId,content:`Visible row ${i}`,createdAt:new Date(sentAt+i)}});
    const listed=await listSiblingThreads(db,botId,current.id);
    expect(listed).toEqual([{sessionId:sibling.id,channelId:ids[1]!,name:`Room ${ids[1]}`,kind:"group chat",lastActivityAt:expect.any(Date)}]);
    // The listed session is readable by its session_id; the transcript tool replaced the sibling reader.
    const read=await readTranscript(db,{botId,channelId:ids[0]!},{in:sibling.id});
    expect(read.rows.map(row=>row.content)).toEqual(["Visible row 1","Visible row 2","Visible row 3"]);
    await db.channel.update({where:{id:ids[1]},data:{archivedAt:new Date()}});
    expect(await listSiblingThreads(db,botId,current.id)).toEqual([]);
    await db.channel.update({where:{id:ids[1]},data:{archivedAt:null}});
    await db.channelMember.deleteMany({where:{channelId:ids[1],botId}});
    expect(await listSiblingThreads(db,botId,current.id)).toEqual([]);
});
