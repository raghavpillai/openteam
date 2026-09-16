import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { listSiblingThreads, readSiblingThread } from "../src/sibling-threads";
import { parseSiblingThreadInput } from "@openteam/contracts/sibling-threads";

test("sibling input uses captured defaults and bounds", () => {
  expect(parseSiblingThreadInput({session_id:" example "})).toEqual({session_id:"example",limit:20});
  for (const limit of [0,51,1.2,"20",NaN]) expect(() => parseSiblingThreadInput({session_id:"example",limit})).toThrow();
});

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)("sibling reads visible bounded history, rejects current, foreign, archived and removed memberships", async () => {
  const db=createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
  const botId=crypto.randomUUID(), otherId=crypto.randomUUID();
  const ids=[crypto.randomUUID(),crypto.randomUUID()];
  try {
    for(const id of [botId,otherId]) await db.bot.create({data:{id,name:"Sibling fixture",defaultDirectory:"/tmp",status:"active",conversation:{create:{}}}});
    for(const id of ids)await db.channel.create({data:{id,kind:"group",name:`Room ${id}`,members:{create:{botId,ordinal:0}}}});
    const current=await db.contextSession.create({data:{botId,scope:"channel",scopeId:ids[0]!}});
    const sibling=await db.contextSession.create({data:{botId,scope:"channel",scopeId:ids[1]!}});
    const foreign=await db.contextSession.create({data:{botId:otherId,scope:"channel",scopeId:ids[1]!}});
    for(let i=1;i<=55;i++)await db.channelMessage.create({data:{channelId:ids[1]!,sender:i%2?"user":"agent",senderBotId:i%2?null:botId,content:`Visible row ${i}`,metadata:{heldValues:{password:"SYNTHETIC-PRIVATE-NEVER-READ"}}}});
    await db.channelMessage.create({data:{channelId:ids[1]!,sender:"system",content:"SYNTHETIC-SYSTEM-EVENT"}});
    expect(await listSiblingThreads(db,botId,current.id)).toEqual([{sessionId:sibling.id,channelId:ids[1]!,name:`Room ${ids[1]}`}]);
    const context={botId,channelId:ids[0]!};
    const recent=await readSiblingThread(db,context,{session_id:sibling.id});
    expect(recent).toContain("most recent 20 rows");expect(recent).toContain("Visible row 36");expect(recent).not.toContain("Visible row 35");expect(recent).not.toContain("SYNTHETIC-PRIVATE");
    expect(recent).not.toContain("SYNTHETIC-SYSTEM-EVENT");
    expect((await readSiblingThread(db,context,{session_id:sibling.id,limit:50})).split("\n")).toHaveLength(52);
    await expect(readSiblingThread(db,context,{session_id:current.id})).rejects.toThrow("current conversation");
    await expect(readSiblingThread(db,context,{session_id:foreign.id})).rejects.toThrow("not readable");
    await db.channel.update({where:{id:ids[1]},data:{archivedAt:new Date()}});
    await expect(readSiblingThread(db,context,{session_id:sibling.id})).rejects.toThrow("not readable");
    await db.channel.update({where:{id:ids[1]},data:{archivedAt:null}});
    await db.channelMember.deleteMany({where:{channelId:ids[1],botId}});
    await expect(readSiblingThread(db,context,{session_id:sibling.id})).rejects.toThrow("not readable");
    expect(await listSiblingThreads(db,botId,current.id)).toEqual([]);
  } finally {
    await db.channel.deleteMany({where:{id:{in:ids}}});await db.bot.deleteMany({where:{id:{in:[botId,otherId]}}});await db.$disconnect();
  }
});
