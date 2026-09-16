import { ApiError } from "@openteam/contracts";
import { HOST_BRIDGE_PATHS, parseHostMachinesResponse } from "@openteam/contracts/service-protocol";
import type { PrismaClient } from "@openteam/db";
export class MachineService {
  constructor(private readonly db:PrismaClient,private readonly token:string,private readonly fetcher:typeof fetch=fetch){}
  async list(probe=false) {
    const rows=await this.db.hostMachine.findMany({orderBy:{createdAt:"asc"}});
    return Promise.all(rows.map(async row=>{
      let connected=false;
      if(probe && row.enabled)try {
        const machine=await this.probe(row.bridgeUrl);
        connected=machine.machineId===row.machineId;
        if(connected)Object.assign(row,await this.db.hostMachine.update({where:{machineId:row.machineId},data:{label:machine.label,lastSeenAt:new Date()}}));
      }catch{/* Keep disconnected machines in the inventory. */}
      return {...row,connected:probe?connected:Boolean(row.enabled&&row.lastSeenAt&&Date.now()-row.lastSeenAt.getTime()<60_000)};
    }));
  }
  private async probe(bridgeUrl:string) {
    const response=await this.fetcher(`${bridgeUrl}${HOST_BRIDGE_PATHS.machines}`,{method:"POST",headers:{authorization:`Bearer ${this.token}`,"content-type":"application/json"},body:"{}",redirect:"error",signal:AbortSignal.timeout(5_000)});
    if(!response.ok)throw new ApiError(409,"machine_unavailable","The computer did not accept the deployment bridge token. Open its desktop app and check the address.");
    const machines=parseHostMachinesResponse(await response.json()).machines;
    if(machines.length!==1)throw new ApiError(409,"machine_identity_invalid","The endpoint must identify one physical computer");
    return machines[0]!;
  }
  async save(raw:unknown) {
    const input=raw as {bridgeUrl?:unknown};
    if(!input || typeof input.bridgeUrl!=="string")throw new ApiError(400,"machine_url_required","Enter the computer's bridge URL");
    let url:URL;try{url=new URL(input.bridgeUrl);}catch{throw new ApiError(400,"machine_url_invalid","Use an HTTP or HTTPS bridge URL");}
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new ApiError(400,"machine_url_invalid","Use an HTTP or HTTPS origin without credentials, paths or query parameters");
    const machine=await this.probe(url.origin);
    return this.db.hostMachine.upsert({where:{machineId:machine.machineId},create:{machineId:machine.machineId,label:machine.label,bridgeUrl:url.origin,lastSeenAt:new Date()},update:{label:machine.label,bridgeUrl:url.origin,lastSeenAt:new Date(),enabled:true}});
  }
  async observe(raw:unknown) {
    const input=raw as {machineId?:unknown;connected?:unknown};
    if(typeof input?.machineId!=="string"||typeof input.connected!=="boolean")throw new ApiError(400,"machine_observation_invalid","Invalid computer status");
    await this.db.hostMachine.updateMany({where:{machineId:input.machineId},data:{lastSeenAt:input.connected?new Date():null}});
    return {updated:true};
  }
  async display(){return await this.db.computerDisplaySettings.findUnique({where:{id:"global"}}) ?? {width:1280,height:800};}
  async saveDisplay(raw:unknown){const value=raw as {width:number;height:number};if(!value || !Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<640||value.width>7680||value.height<480||value.height>4320)throw new ApiError(400,"invalid_display","Choose a width of 640–7680 and height of 480–4320 pixels");return this.db.computerDisplaySettings.upsert({where:{id:"global"},create:{id:"global",width:value.width,height:value.height},update:{width:value.width,height:value.height}});}
  async remove(machineId:string){await this.db.hostMachine.deleteMany({where:{machineId}});return {removed:true};}
}
