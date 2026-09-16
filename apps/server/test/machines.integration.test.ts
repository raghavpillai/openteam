import {test,expect} from "bun:test";
import {createPrismaClient} from "@openteam/db";
import {MachineService} from "../src/services/machine-service";
import {MachineDirectory} from "../../computer/src/machine-directory";
test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)("registered machines survive disconnects and route selected computers",async()=>{
 const db=createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
 const id=crypto.randomUUID();let online=true;
 const bridge=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){expect(request.headers.get("authorization")).toBe("Bearer fixture");return online ? Response.json({machines:[{machineId:id,label:"Fixture laptop",localToolPermission:"always"}]}) : new Response(null,{status:503});}});
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
  const result=await disabled.enroll({machineId,label:"Local fixture",localToolPermission:"ask"},null);
  const request=new Request("http://fixture/channel",{headers:{authorization:`Bearer ${result.credential}`,"x-openteam-machine-id":machineId}});
  expect((await disabled.authenticate(request)).machineId).toBe(machineId);
  await expect(required.authenticate(request)).rejects.toThrow("no longer authorized");
  await expect(required.assertRoutable(machineId)).rejects.toThrow("not available");
 }finally{disabled.relay.close();required.relay.close();await db.hostMachine.deleteMany({where:{machineId}});await db.$disconnect();}
});
