import type {ClientSnapshot} from '../../../packages/contracts/src/index';
export function contentScene(snapshot: ClientSnapshot, scene:string) {
  snapshot.runs=[];snapshot.approvals=[];
  const message:any={id:'content-fixture',sequence:'400',channelId:'channel-research',sender:'bot',senderBotId:'bot-research',sourceRunId:null,content:'',metadata:{},createdAt:'2026-09-16T12:00:00.000Z'};
  if(scene==='media-markdown')message.content='Host `22b6e03`. Desktop labels beyond `/home/box/reference/app-ui.md` are **UNVERIFIED** (no renderer/asar this pass). Cloud-agent archive is a different product, not group/A2A.\n\n**Mute / unmute — ABSENT**\nNo group/A2A mute symbol, RPC, or UI. Remaining `mute*` hits are Twitter OAuth, a Slack chatter Statsig gate, and widget “muted Dismissed”.\n\n**Archive / unarchive — ABSENT** for groups/A2A\n\n- `app-ui.md`: sidebar right-click **"Delete"** (permanent, confirm). Quote: no archive or hide, just this delete.\n- Host `deleteAgents` RPC exists; no `archiveAgent` / group archive.\n- **Related, not archive:** `hiddenFromSidebar` / RPC `setAgentHiddenFromSidebar` (`agent-files.ts`, `server-agent-action-core.ts`). Tool copy: removes the row; still reachable via Cmd-K and the Hidden chats manager. Placement of that toggle: **UNVERIFIED** in the visual UI map (not listed in `app-ui.md` settings rows).\n- CloudAgent `archive/unarchive`: **SHIPPED** for cloud agents only (`cloud-agent-tool.ts`). Not group lifecycle.';
  if(scene==='media' || scene==='media-files') {
    const bot=snapshot.bots.find(b=>b.id==='bot-research')!;
    const channel=snapshot.channels.find(c=>c.id==='channel-research')!;
    bot.name=channel.name=scene==='media'?'Parity Probe v3':'Memory Box 914';
    const messages:any[]=[];
    if(scene==='media') {
      for(let i=1;i<=6;i++)messages.push({...message,id:'photo-'+i,sequence:String(400+i),metadata:{attachments:[{assetId:String(i).repeat(64),fileName:'Desktop '+i+'.png',mimeType:'image/png',byteSize:46000,kind:'image',width:545,height:341,alt:i===5?'Omnibox after handoff with _HANDOFF_TEST appended':'Desktop capture '+i}]}});
    } else {
      for(const [i,name,size] of [[7,'memory-runtime-audit-914.zip',38000],[8,'memory-deep-audit-914.zip',54000],[9,'memory-deep-supplement-914.zip',5000]] as const) {
        messages.push({...message,id:'file-request-'+i,sequence:String(400+i*3),sender:'user',senderBotId:null,content:'Attach the existing file /workspace/'+name+' unchanged. Do not rerun or alter any tests, inspect unrelated files, or publish anything.'});
        messages.push({...message,id:'file-text-'+i,sequence:String(401+i*3),content:'Attaching the existing archive unchanged.'});
        messages.push({...message,id:'file-'+i,sequence:String(402+i*3),metadata:{attachment:{assetId:String(i).repeat(64),fileName:name,mimeType:'application/zip',byteSize:size,kind:'file'}}});
      }
    }
    snapshot.channelMessages=snapshot.channelMessages.filter(m=>m.channelId!=='channel-research');snapshot.channelMessages.push(...messages);return snapshot;
  }
  if(scene==='markdown')message.content='# Native document\n\nA **bold** summary with a [safe link](https://example.com).\n\n| Feature | Status |\n|---|---|\n| Tables | Ready |\n| Math | Ready |\n\n$$\\frac{a^2+b^2}{c}=42$$\n\n```mermaid\nflowchart LR\n A[Draft] --> B[Review]\n B --> C[Done]\n```\n\n> Diagrams and formulas stay offline.\n\n<script>document.body.innerHTML="Unsafe script executed"</script><img src="https://example.invalid/tracker.png" onerror="document.body.innerHTML=\'Unsafe script executed\'">';
  if(scene==='form')message.metadata={type:'user-form',cardState:'pending',form:{id:'form-fixture',title:'Native details form',instruction:'Confirm the details before filling the form.',domain:'fixture.invalid',fields:[{id:'name',label:'Name',placeholder:'Your name',type:'text',required:true},{id:'email',label:'Email',placeholder:'Email address',type:'email',required:true},{id:'consent',label:'Confirm these details',type:'checkbox',required:true}]}};
  if(scene==='handoff')message.metadata={type:'computer-handoff',computerHandoff:{reason:'Check the fixture desktop and return control.'},computerHandoffState:'requested'};
  if(scene==='attachment')message.metadata={attachments:[{assetId:'private-fixture-image',fileName:'Fixture image.png',mimeType:'image/png',byteSize:6000,kind:'image'}]};
  snapshot.channelMessages=snapshot.channelMessages.filter(m=>m.channelId!=='channel-research');snapshot.channelMessages.push(message);return snapshot;
}
