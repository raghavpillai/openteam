import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { listSiblingThreads, renderOtherActiveConversations, type SiblingThread } from "../src/sibling-threads";
import { readTranscript } from "../src/read-transcript";

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

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)("other conversations list visible sessions that ReadTranscript reads, never the current, archived, left or agent-to-agent ones", async () => {
  const db=createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
  const botId=crypto.randomUUID(), peerId=crypto.randomUUID();
  const ids=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
  try {
    for(const id of [botId,peerId]) await db.bot.create({data:{id,name:"Sibling fixture",defaultDirectory:"/tmp",status:"active",conversation:{create:{}}}});
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
  } finally {
    await db.channel.deleteMany({where:{id:{in:ids}}});await db.bot.deleteMany({where:{id:{in:[botId,peerId]}}});await db.$disconnect();
  }
});
