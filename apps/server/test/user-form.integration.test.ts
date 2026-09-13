import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrismaClient } from '@openteam/db';
import { AgentDataStore, AgentMessaging } from '@openteam/messaging';
import { Effect } from 'effect';
import { RichMessageService } from '../src/services/rich-message-service';
import type { UserFormReceipt } from '@openteam/contracts';

const databaseUrl=process.env.OPENTEAM_TEST_DATABASE_URL;
test('form response is value-free, durable, replayable until acknowledged, and idempotent',async()=>{
 if(!databaseUrl)return;
 const prisma=createPrismaClient(databaseUrl); const root=await mkdtemp(join(tmpdir(),'form-service-'));
 const botId=crypto.randomUUID(),conversationId=crypto.randomUUID(),channelId=crypto.randomUUID(),runId=crypto.randomUUID();
 const data=new AgentDataStore(prisma,{root:join(root,'data'),workspaceRoot:root});
 const messaging=new AgentMessaging(prisma,{send:async()=>crypto.randomUUID(),sendDebounced:async()=>crypto.randomUUID()} as never,data);
 const secret='SYNTHETIC_FORM_SECRET_NOT_FOR_DB'; const email='private-fixture@example.com'; let hostCalls=0;
 const screens={userFormAction:async (_bot:string,formId:string,action:string,input:{form?:unknown;values?:unknown})=>{
  if(action==='prepare')return input.form;
  hostCalls++;expect(input.values).toEqual({email,password:secret});
  return {formId,status:'submitted',fields:[{id:'email',status:'filled'},{id:'password',status:'filled'}],submitAttempted:false,submitSucceeded:false} satisfies UserFormReceipt;
 }};
 const service=new RichMessageService(prisma,messaging,{} as never,screens as never);
 try{
  await mkdir(root,{recursive:true});
  await prisma.bot.create({data:{id:botId,name:'Form test',defaultDirectory:root,status:'active',onboardingStatus:'completed',conversation:{create:{id:conversationId}}}});
  await prisma.channel.create({data:{id:channelId,kind:'bot_dm',name:'Form test',directKey:`bot:${botId}`,members:{create:{botId,ordinal:0}}}});
  const trigger = await prisma.message.create({data:{botId,conversationId,role:'user',content:'Sign in to the fixture',status:'completed',clientId:'form-fixture'}});
  await prisma.run.create({data:{id:runId,botId,conversationId,channelId,userMessageId:trigger.id,status:'running',origin:'user'}});
  await data.initializeBot(botId);
  await data.writeRootSettings({});
  const context={runId,botId,conversationId,channelId,deliveryId:null,origin:'user' as const,callId:'form-test',isFork:false,replyToMessageId:null};
  const form={title:'Sign in',instruction:'Use the fixture',domain:'example.com',fields:[{id:'email',label:'Email',type:'email',target:{kind:'selector',value:'#email'}},{id:'password',label:'Password',type:'password',target:{kind:'selector',value:'#password'}}]};
  const created=await service.createUserForm(context,form) as {sent:boolean;message_id:string};expect(created.sent).toBe(true);
  const first=await Effect.runPromise(service.submitUserForm(created.message_id,{action:'submit',values:{email,password:secret}}));expect(first.accepted).toBe(true);
  const again=await Effect.runPromise(service.submitUserForm(created.message_id,{action:'submit',values:{email:'changed',password:'changed'}}));expect(again.accepted).toBe(false);expect(hostCalls).toBe(1);
  const before=await messaging.platformPrompt(botId);expect(before.ambientContext).toContain('email: FILLED');
  const retry=await messaging.platformPrompt(botId);expect(retry.ambientContext).toContain('email: FILLED');
  await messaging.acknowledgePlatformPrompt(botId,undefined,before);
  expect((await messaging.platformPrompt(botId)).ambientContext ?? '').not.toContain('email: FILLED');
  const transcriptData=await Promise.all([prisma.channelMessage.findMany({where:{channelId}}),prisma.inboxEvent.findMany({where:{botId}}),prisma.message.findMany({where:{conversationId}}),prisma.event.findMany({where:{entityId:created.message_id}})]);
  const serialized=JSON.stringify(transcriptData,(_key,value)=>typeof value==='bigint'?String(value):value);
  expect(serialized).not.toContain(secret);expect(serialized).not.toContain(email);
  expect(await prisma.inboxEvent.count({where:{botId,type:'form.response'}})).toBe(1);
 }finally{await prisma.bot.deleteMany({where:{id:botId}});await prisma.channel.deleteMany({where:{id:channelId}});await prisma.$disconnect();await rm(root,{recursive:true,force:true});}
});
