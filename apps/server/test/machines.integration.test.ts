import {test,expect} from "bun:test";
import {createPrismaClient} from "@openteam/db";
import {MachineService} from "../src/services/machine-service";
import {MachineDirectory} from "../../computer/src/machine-directory";
test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)("registered machines survive disconnects and route selected computers",async()=>{
 const db=createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
 const id=crypto.randomUUID();let online=true;
 const bridge=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){expect(request.headers.get("authorization")).toBe("Bearer fixture");return online ? Response.json({machines:[{machineId:id,label:"Fixture laptop",}]}) : new Response(null,{status:503});}});
 const service=new MachineService(db,"fixture");
 const api=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){const path=new URL(request.url).pathname;if(path.endsWith("/observe"))return Response.json(await service.observe(await request.json()));return Response.json(await service.list());}});
 try {
  await service.save({bridgeUrl:bridge.url.origin});
  expect((await service.list(true)).find(row=>row.machineId===id)).toMatchObject({connected:true,label:"Fixture laptop"});
  const directory=new MachineDirectory(api.url.origin,"fixture",bridge.url.origin);
  expect(await directory.endpoint(id)).toBe(bridge.url.origin);
  await expect(directory.endpoint("unregistered-computer")).rejects.toThrow("ListMachines");
  expect(await directory.endpoint(undefined)).toBe(bridge.url.origin);
  expect((await directory.list()).find(row=>row.machineId===id)).toMatchObject({connected:true});
  online=false;
  expect((await directory.list()).find(row=>row.machineId===id)).toMatchObject({connected:false,label:"Fixture laptop"});
  expect(await db.hostMachine.count({where:{machineId:id}})).toBe(1);
  await db.hostMachine.update({where:{machineId:id},data:{enabled:false}});
  await expect(directory.endpoint(id)).rejects.toThrow("disabled");
  await expect(service.save({bridgeUrl:"file:///etc"})).rejects.toThrow("HTTP");
 }finally{service.relay.close();bridge.stop(true);api.stop(true);await service.remove(id);await db.$disconnect();}
});

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)("auth-disabled enrollment is rejected after required authentication is enabled",async()=>{
 const db=createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
 const disabled=new MachineService(db,"fixture",undefined,undefined,true),required=new MachineService(db,"fixture");
 const machineId=crypto.randomUUID();
 try{
  const result=await disabled.enroll({machineId,label:"Local fixture",},null);
  const request=new Request("http://fixture/channel",{headers:{authorization:`Bearer ${result.credential}`,"x-openteam-machine-id":machineId}});
  expect((await disabled.authenticate(request)).machineId).toBe(machineId);
  await expect(required.authenticate(request)).rejects.toThrow("no longer authorized");
  await expect(required.assertRoutable(machineId)).rejects.toThrow("not available");
 }finally{disabled.relay.close();required.relay.close();await db.hostMachine.deleteMany({where:{machineId}});await db.$disconnect();}
});

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)("Messages runs on a connected Mac that turned it on and fails over when one sleeps",async()=>{
 const db=createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
 const service=new MachineService(db,"fixture",undefined,undefined,true);
 const air=crypto.randomUUID(),mini=crypto.randomUUID(),phone=crypto.randomUUID();
 const ready={enabled:true,fullDiskAccess:true,automation:"granted",contacts:"granted"};
 let preferred:string|null=null;
 (service as unknown as {preferred:()=>Promise<{machineId:string|null}>}).preferred=async()=>({machineId:preferred});
 const pick=(machineId?:string)=>service.messagesMachine(crypto.randomUUID(),undefined,machineId).then(row=>row.label);
 try{
  for(const [machineId,label] of [[air,"MacBook Air"],[mini,"Mac mini"],[phone,"Linux box"]] as const){await service.enroll({machineId,label},null);service.relay.connect(machineId);}
  await expect(pick()).rejects.toThrow("No Mac with Messages turned on is connected");
  await service.heartbeat(air,{label:"MacBook Air",messages:ready});
  await service.heartbeat(mini,{label:"Mac mini",messages:{...ready,enabled:false}});
  await service.heartbeat(phone,{label:"Linux box"});
  expect((await service.list()).filter(row=>[air,mini,phone].includes(row.machineId)).map(row=>row.messages).sort()).toEqual(["off","ready","unavailable"]);
  expect(await pick()).toBe("MacBook Air");
  await expect(pick(mini)).rejects.toThrow("Messages is turned off on Mac mini");
  service.relay.disconnect(air);
  await expect(pick()).rejects.toThrow("Messages is turned off on every connected Mac");
  service.relay.connect(air);
  await expect(pick(phone)).rejects.toThrow("isn't a Mac");
  await service.heartbeat(mini,{label:"Mac mini",messages:{...ready,fullDiskAccess:false}});
  expect((await service.list()).find(row=>row.machineId===mini)?.messages).toBe("needs_permission");
  await service.heartbeat(mini,{label:"Mac mini",messages:ready});
  // Two ready Macs: the one the user last wrote from, else ask which.
  await expect(pick()).rejects.toThrow("more than one connected Mac");
  preferred=air;
  expect(await pick()).toBe("MacBook Air");
  expect(await pick(mini)).toBe("Mac mini");
  // The Air sleeps: its channel closes and the Mac mini takes over.
  service.relay.disconnect(air);
  expect(await pick()).toBe("Mac mini");
  await expect(pick(air)).rejects.toThrow("MacBook Air is offline");
  service.relay.disconnect(mini);
  await expect(pick()).rejects.toThrow("No Mac with Messages turned on is connected");
  await expect(pick(crypto.randomUUID())).rejects.toThrow("Call ListMachines");

  // Send rules belong to one Mac and end when its Messages switch flips.
  expect(await service.messagesSendAllowed(air,"+15555550100")).toBe(false);
  await service.allowMessagesRecipient(air,"Alex@Example.com","Alex");
  expect(await service.messagesSendAllowed(air,"alex@example.com")).toBe(true);
  expect(await service.messagesSendAllowed(mini,"alex@example.com")).toBe(false);
  await service.updateMessagesSettings(mini,{sendWithoutAsking:true});
  expect(await service.messagesSendAllowed(mini,undefined)).toBe(true);
  expect((await service.messagesSettings(air)).allowedRecipients).toEqual([{recipient:"alex@example.com",recipientName:"Alex"}]);
  await service.heartbeat(air,{label:"MacBook Air",messages:{...ready,enabled:false}});
  await service.heartbeat(air,{label:"MacBook Air",messages:ready});
  expect(await service.messagesSettings(air)).toMatchObject({sendWithoutAsking:false,allowedRecipients:[]});
  expect(await service.messagesSendAllowed(air,"alex@example.com")).toBe(false);
  await service.updateMessagesSettings(air,{removeRecipient:"nobody"});

  // Removing a computer forgets it, rules included.
  await service.remove(mini);
  expect(await db.hostMachine.count({where:{machineId:mini}})).toBe(0);
 }finally{service.relay.close();await db.hostMachine.deleteMany({where:{machineId:{in:[air,mini,phone]}}});await db.$disconnect();}
});
