/** Inert service-contract fixtures for native failure/recovery tests. Never connects externally. */
export class FunctionalFixtures {
  sources: any[] = [];
  skills: any[] = [];
  drafts: any[] = [];
  installs: any[] = [];
  policies: any[] = [];
  access = new Set<string>();
  configuration: any = { connectionId: "fixture-connection", namespace: "fixture", endpoint: "https://fixture.invalid/mcp", command: null, args: [], cwd: null, values: {region:"east"}, fields: [{key:"region",label:"Region",type:"string",required:true,secret:false},{key:"token",label:"API token",required:true,secret:true}], configuredSecrets:["token"], headerNames:[],environmentNames:[], setup:null,callbackUrl:"",tokenEndpointAuthMethod:"none" };
  catalog = [{key:"fixture-notes",name:"Fixture Notes",description:"An isolated notes plugin for native contract tests.",publisher:"OpenTeam QA",version:"1.0.0",installed:false,setupFields:[],connections:[],hasSkills:true}];
  connection = {id:"fixture-connection",revision:"1",pluginKey:"fixture-notes",connectorKey:"notes",name:"Notes",alias:"Main",transport:"http",auth:"token",status:"ready",statusMessage:null,instructions:"Keep notes concise.",canAuthenticate:false,configured:true,command:null,tools:[{name:"list_notes",description:"List fixture notes.",risk:"read",defaultDecision:"prompt"}]};
  settings(bots: any[]) {return {catalog:this.catalog,installs:this.installs,policies:this.policies,activity:[],botCount:bots.length};}
  async handle(path: string, method: string, input: any, url: URL, bots: any[]): Promise<Response | null> {
    const reply = (body: any,status=200) => Response.json(body,{status});
    if(path === "/api/v0/plugins") return reply(this.settings(bots));
    if(path === "/api/v0/plugin-management") return reply({sources:this.sources,skills:this.skills,drafts:this.drafts});
    if(path === "/api/v0/plugins/install") {
      if(!this.installs.length) this.installs.push({id:"fixture-install",pluginKey:"fixture-notes",name:"Fixture Notes",description:this.catalog[0]!.description,publisher:"OpenTeam QA",version:"1.0.0",status:"installed",hasSkills:true,connections:[this.connection]});
      this.catalog[0]!.installed=true;return reply({ok:true});
    }
    if(path === "/api/v0/plugins/fixture-notes" && method === "DELETE") {this.installs=[];this.catalog[0]!.installed=false;return reply({ok:true});}
    if(path.endsWith("/bot-access")) {
      const offset=Number(url.searchParams.get("offset") || 0),limit=Number(url.searchParams.get("limit") || 100),q=url.searchParams.get("q") || "";
      const rows=bots.filter(b=>b.name.toLowerCase().includes(q.toLowerCase())).map(b=>({...b,skillsEnabled:this.access.has(b.id),grantedConnectionIds:this.access.has(b.id)?[this.connection.id]:[]}));
      return reply({pluginKey:"fixture-notes",query:q,offset,total:rows.length,bots:rows.slice(offset,offset+limit)});
    }
    if(path.endsWith("/enablement")) {if(input.enabled)this.access.add(input.botId);else this.access.delete(input.botId);return reply({ok:true});}
    if(path.includes("/plugin-connections/")) {
      if(path.endsWith("/configuration")) {
        if(method==="PUT") {
          this.configuration={...this.configuration,...input,secrets:undefined};
          for(const [key,action] of Object.entries(input.secrets ?? {}) as any){
            if(action.action==="clear")this.configuration.configuredSecrets=this.configuration.configuredSecrets.filter((v:string)=>v!==key);
            if(action.action==="replace"&&!this.configuration.configuredSecrets.includes(key))this.configuration.configuredSecrets.push(key);
          }
        }
        return reply(this.configuration);
      }
      if(path.endsWith("/instructions")){this.connection.instructions=input.instructions;return reply({ok:true});}
      if(path.endsWith("/policy")){this.policies=this.policies.filter(p=>p.toolName!==input.toolName||p.botId!==input.botId);this.policies.push({...input,connectionId:this.connection.id});return reply({ok:true});}
      if(path.endsWith("/account")){if(method==="PATCH")this.connection.alias=input.alias;return reply({ok:true});}
      if(path.endsWith("/accounts"))return reply({id:"another-fixture-account",alias:input.alias});
      if(path.endsWith("/test"))return reply({result:{notes:["Fixture note"],toolName:input.toolName}});
      if(path.endsWith("/connect")||path.endsWith("/restart"))this.connection.status="ready";
      if(path.endsWith("/disconnect"))this.connection.status="disconnected";
      return reply({ok:true});
    }
    if(path === "/api/v0/plugins/custom-mcp")return reply({id:"fixture-custom",...input});
    if(path === "/api/v0/plugins/sync")return reply({ok:true});
    if(path.startsWith("/api/v0/plugin-sources")) {
      const id=path.split("/")[4];
      if(method==="DELETE")this.sources=this.sources.filter(s=>s.id!==id);
      else if(method==="PUT")Object.assign(this.sources.find(s=>s.id===id)??{},input);
      else if(!path.endsWith("/refresh"))this.sources.push({id:crypto.randomUUID(),...input,status:"ready",error:null,pluginCount:1});
      return reply({ok:true});
    }
    if(path.startsWith("/api/v0/plugin-skills")) {
      const id=path.split("/")[4] || crypto.randomUUID();
      if(method==="DELETE")this.skills=this.skills.filter(s=>s.id!==id);
      else if(method==="PUT")Object.assign(this.skills.find(s=>s.id===id)??{},input);
      else this.skills.push({id,...input});
      return reply({id});
    }
    if(path.endsWith("/package"))return reply({definition:{name:"Fixture Notes"},digest:"fixture-digest",mode:"optional",skillSyncStatus:"ready",skillSyncError:null,hasRollback:true,update:null});
    if(path.endsWith("/export"))return reply({filename:"fixture.zip",base64:Buffer.from("inert fixture archive").toString("base64")});
    if(path.endsWith("/mode")||path.endsWith("/rollback")||path.endsWith("/update"))return reply({ok:true});
    if(path.startsWith("/api/v0/plugin-drafts")) {
      const id=path.split("/")[4];
      if(method==="DELETE"){this.drafts=this.drafts.filter(d=>d.id!==id);return reply({ok:true});}
      if(method==="PUT"){const d=this.drafts.find(d=>d.id===id);Object.assign(d??{},input);return reply(d);}
      if(path.endsWith("/install"))return reply({ok:true});
      const draft={id:crypto.randomUUID(),name:"Imported fixture",definition:{name:"Imported fixture",version:"1.0.0",skills:[]},digest:"fixture-digest",files:input.files??{},errors:[],warnings:[]};this.drafts.push(draft);return reply(draft);
    }
    return null;
  }
}
