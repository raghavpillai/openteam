import { HOST_BRIDGE_PATHS,parseHostMachinesResponse,type HostMachine } from "@openteam/contracts/service-protocol";
export type MachineMessagesState = "ready" | "needs_permission" | "off" | "unavailable";
export interface RegisteredMachine {machineId:string;label:string;bridgeUrl:string|null;transport?:string;enabled:boolean;connected?:boolean;messages?:MachineMessagesState}
export class MachineDirectory {
  constructor(private readonly serverUrl:string,private readonly token:string,private readonly defaultBridge:string,private readonly fetcher:typeof fetch=fetch){}
  private async request(path:string,body?:unknown,signal?:AbortSignal){
    const response=await this.fetcher(`${this.serverUrl}/api/v0/internal/machines${path}`,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${this.token}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8_000)]):AbortSignal.timeout(8_000)});
    if(!response.ok){
      // Routing refusals are written for the model; anything else stays generic.
      const message=(await response.json().catch(()=>null) as {error?:{message?:unknown}}|null)?.error?.message;
      throw new Error(response.status===409||response.status===404?String(message??"Machine inventory is unavailable"):"Machine inventory is unavailable");
    }
    return response.json();
  }
  async registered(signal?:AbortSignal):Promise<RegisteredMachine[]>{return this.request("",undefined,signal);}
  async preferred(botId:string,channelId?:string,signal?:AbortSignal):Promise<string|undefined>{
    const params=new URLSearchParams({botId,...(channelId?{channelId}:{})});
    const result=await this.request(`/preferred?${params}`,undefined,signal) as {machineId:string|null};
    return result.machineId ?? undefined;
  }
  /** The Mac a Messages tool runs on, chosen by the server from the Macs with Messages turned on. */
  async messagesMachine(botId:string,channelId?:string,machineId?:string,signal?:AbortSignal):Promise<string>{
    const params=new URLSearchParams({botId,...(channelId?{channelId}:{}),...(machineId?{machineId}:{})});
    return (await this.request(`/messages?${params}`,undefined,signal) as {machineId:string}).machineId;
  }
  /** Messages tools are offered only while a connected Mac has Messages turned on. */
  async messagesAvailable(signal?:AbortSignal):Promise<boolean>{
    return (await this.registered(signal)).some(row=>row.transport==="relay"&&row.connected&&(row.messages==="ready"||row.messages==="needs_permission"));
  }
  async endpoint(machineId:string|undefined,signal?:AbortSignal):Promise<string>{
    const rows=await this.registered(signal);
    if (!machineId) {
      const defaults = rows.filter(row => row.enabled);
      const direct = defaults.find(row => row.bridgeUrl === this.defaultBridge);
      if (direct) return this.defaultBridge;
      if (defaults.length === 1) {
        const only = defaults[0]!;
        return only.transport === "relay" ? `${this.serverUrl}/api/v0/internal/machines/${encodeURIComponent(only.machineId)}/bridge` : only.bridgeUrl!;
      }
      if (defaults.length > 1) throw new Error("More than one computer is registered. Run ListMachines and select a machineId.");
      if (rows.length) throw new Error("Registered computers are disabled. Enable a computer in settings before using it.");
      return this.defaultBridge;
    }
    const found=rows.find(row=>row.machineId===machineId);
    if(found){if(!found.enabled)throw new Error(`Computer ${found.label} is disabled`);return found.transport === "relay" ? `${this.serverUrl}/api/v0/internal/machines/${encodeURIComponent(found.machineId)}/bridge` : found.bridgeUrl!;}
    throw new Error(`Computer ${machineId} is not registered. Run ListMachines and use one of its machine IDs.`);
  }
  async list(signal?:AbortSignal):Promise<Array<HostMachine & {connected:boolean;messages?:MachineMessagesState}>>{
    let rows=await this.registered(signal);
    if(!rows.length){
      try{await this.request("/register",{bridgeUrl:this.defaultBridge},signal);rows=await this.registered(signal);}catch{signal?.throwIfAborted();}
    }
    return Promise.all(rows.map(async row=>{
      let machine:HostMachine={machineId:row.machineId,label:row.label};let connected=false;
      if(row.transport === "relay")return {...machine,connected:row.enabled && !!row.connected,messages:row.messages ?? "unavailable"};
      if(row.enabled)try{
        const response=await this.fetcher(`${row.bridgeUrl}${HOST_BRIDGE_PATHS.machines}`,{method:"POST",headers:{authorization:`Bearer ${this.token}`,"content-type":"application/json"},body:"{}",redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5_000)]):AbortSignal.timeout(5_000)});
        if(response.ok){const actual=parseHostMachinesResponse(await response.json()).machines.find(item=>item.machineId===row.machineId);if(actual){machine=actual;connected=true;}}
      }catch{signal?.throwIfAborted();}
      await this.request("/observe",{machineId:row.machineId,connected},signal).catch(()=>{});
      return {...machine,connected,messages:"unavailable" as const};
    }));
  }
}
