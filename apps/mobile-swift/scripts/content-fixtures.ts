import type {ClientSnapshot} from '../../../packages/contracts/src/index';
export function contentScene(snapshot: ClientSnapshot, scene:string) {
  snapshot.runs=[];snapshot.approvals=[];
  const message:any={id:'content-fixture',sequence:'400',channelId:'channel-research',sender:'bot',senderBotId:'bot-research',sourceRunId:null,content:'',metadata:{},createdAt:'2026-09-16T12:00:00.000Z'};
  if(scene==='markdown')message.content='# Native document\n\nA **bold** summary with a [safe link](https://example.com).\n\n| Feature | Status |\n|---|---|\n| Tables | Ready |\n| Math | Ready |\n\n$$\\frac{a^2+b^2}{c}=42$$\n\n```mermaid\nflowchart LR\n A[Draft] --> B[Review]\n B --> C[Done]\n```\n\n> Diagrams and formulas stay offline.\n\n<script>document.body.innerHTML="Unsafe script executed"</script><img src="https://example.invalid/tracker.png" onerror="document.body.innerHTML=\'Unsafe script executed\'">';
  if(scene==='form')message.metadata={type:'user-form',cardState:'pending',form:{id:'form-fixture',title:'Native details form',instruction:'Confirm the details before filling the form.',domain:'fixture.invalid',fields:[{id:'name',label:'Name',placeholder:'Your name',type:'text',required:true},{id:'email',label:'Email',placeholder:'Email address',type:'email',required:true},{id:'consent',label:'Confirm these details',type:'checkbox',required:true}]}};
  if(scene==='handoff')message.metadata={type:'computer-handoff',computerHandoff:{reason:'Check the fixture desktop and return control.'},computerHandoffState:'requested'};
  if(scene==='attachment')message.metadata={attachments:[{assetId:'private-fixture-image',fileName:'Fixture image.png',mimeType:'image/png',byteSize:6000,kind:'image'}]};
  snapshot.channelMessages=snapshot.channelMessages.filter(m=>m.channelId!=='channel-research');snapshot.channelMessages.push(message);return snapshot;
}
