import {expect,test} from "bun:test";
import {createPrismaClient} from "@openteam/db";
import {AgentMessaging,nextMessageAddress,resolveMessageAddress} from "../src";

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)("delivery addresses survive concurrent sends, replies, reactions and a fresh messaging service",async()=>{
 const db=createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
 const botId=crypto.randomUUID(),channelId=crypto.randomUUID(),groupId=crypto.randomUUID(),conversationId=crypto.randomUUID();
 const messaging=()=>new AgentMessaging(db,{send:async()=>crypto.randomUUID(),sendDebounced:async()=>crypto.randomUUID()} as never);
 const context={botId,channelId,conversationId,runId:crypto.randomUUID(),deliveryId:null,origin:"user" as const,callId:"",isFork:false,replyToMessageId:null};
 try {
  await db.bot.create({data:{id:botId,name:"Address fixture",defaultDirectory:"/tmp",status:"active",conversation:{create:{id:conversationId}}}});
  for(const [id,kind] of [[channelId,"bot_dm"],[groupId,"group"]] as const) await db.channel.create({data:{id,kind,name:"Address fixture",members:{create:{botId,ordinal:0}}}});
  await db.run.create({data:{id:context.runId,botId,channelId,conversationId,userMessageId:crypto.randomUUID(),status:"running",origin:"user"}});
  const user=await db.$transaction(async tx=>tx.channelMessage.create({data:{channelId,sender:"user",clientId:crypto.randomUUID(),content:"Fixture",metadata:{address:await nextMessageAddress(tx,channelId,"user")}}}));
  expect(user.metadata).toMatchObject({address:"t0u"});
  const sends=await Promise.all(Array.from({length:6},(_,i)=>messaging().sendVisible({...context,callId:`send-${i}`},{type:"text",content:`Reply ${i}`,to:"dm"})));
  expect(sends.map(s=>(s.acknowledgement as any).message_address).sort()).toEqual(["t0s0","t0s1","t0s2","t0s3","t0s4","t0s5"]);
  const reply=await messaging().sendVisible({...context,callId:"reply"},{type:"text",content:"Threaded",reply_to:"t0u"});
  expect((await db.channelMessage.findUniqueOrThrow({where:{id:(reply.acknowledgement as any).message_id}})).metadata).toMatchObject({replyTo:user.id,address:"t0s6"});
  await messaging().reactToMessage({...context,callId:"reaction"},{message_address:"t0u",emoji:"👍"});
  expect((await db.channelMessage.findUniqueOrThrow({where:{id:user.id}})).metadata).toMatchObject({reactions:[{by:"agent",emoji:"👍"}]});
  const direct=await messaging().sendVisible({...context,channelId:groupId,callId:"private-from-group"},{type:"text",content:"Private",to:"dm"});
  expect(direct.acknowledgement).toMatchObject({channel_id:channelId,message_address:"t0s7"});
  expect(await db.$transaction(tx=>resolveMessageAddress(tx,groupId,"t0s0"))).toBeNull();
  expect(await db.$transaction(tx=>resolveMessageAddress(tx,channelId,"t99s1"))).toBeNull();
  const replay=await messaging().sendVisible({...context,callId:"reply"},{type:"text",content:"Threaded",reply_to:"t0u"});
  expect(replay.acknowledgement).toMatchObject({duplicate:true,message_address:"t0s6"});
 }finally{await db.idempotencyRecord.deleteMany({where:{scope:`reaction:${botId}`}});await db.channel.deleteMany({where:{id:{in:[channelId,groupId]}}});await db.bot.deleteMany({where:{id:botId}});await db.$disconnect();}
});
