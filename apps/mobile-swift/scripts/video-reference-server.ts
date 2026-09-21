/** Isolated visual fixture for September 21 reference. Does not call real bots. */
const upstream='http://127.0.0.1:20122';
let scene='single',revision=5000, messages:any[]=[],active=false,delay=false;
let receipts:any[]=[];let failOnce=false;let loseOnce=false;let workOnAnswer=false;
const channel='channel-research';
const msg=(id:string,content:string,metadata:any={},sender='agent',bot='bot-research'):any=>({id,channelId:channel,sequence:String(++revision),sender,senderBotId:sender==='user'?null:bot,sourceRunId:null,content,metadata,createdAt:'2026-09-21T05:10:00Z'});
function reset(name:string){
 scene=name;active=false;delay=name==='opening';receipts=[];failOnce=false;loseOnce=false;workOnAnswer=false;
 const widget={prompt:'Widget parity — pick any options',helpText:'Parity widget: styles + multiSelect + allowCustom + dismissOnMoveOn. Synthetic UI test — no side effects.',multiSelect:true,allowCustom:true,dismissOnMoveOn:true,options:[{label:'Default',value:'default',description:'Default style option',style:'default'},{label:'Primary',value:'primary',description:'Primary style option',style:'primary'},{label:'Danger',value:'danger',description:'Danger style option',style:'danger'}]};
 const single={prompt:'Deploy lane?',helpText:'Single-select, primary vs danger.',options:[{label:'Ship it',value:'ship',style:'primary'},{label:'Hold',value:'hold'},{label:'Abort',value:'abort',style:'danger'}]};
 if(['multi','dismissed','single','completed'].includes(name))messages=[msg('card','',{type:'widget',widget:['multi','dismissed'].includes(name)?widget:single,...(name==='completed'?{respondedValue:'ship'}:{}),...(name==='dismissed'?{widgetDismissed:true}:{})})];
 if(name==='reading')messages=[...Array.from({length:6},(_,i)=>msg('before-'+i,'Before card '+i)),msg('card','',{type:'widget',widget:single}),...Array.from({length:12},(_,i)=>msg('after-'+i,'After card '+i))];
 if(name==='reply'||name==='thread'){
  messages=[msg('root','No facts in your memory match "LANTERN914" (0 searched). Try different words, or a shorter literal fragment.')];
  if(name==='thread')messages.push(msg('reply','DM here reply',{type:'text',branched:true,replyTo:'root'},'user'));
 }
 if(name==='exchange')messages=[msg('exchange-in','Hey — user asked us to DM each other from Parity Probe Room. Ack from New Bot.',{fromAgent:{id:'bot-ops',name:'New Bot'}})];
 if(name==='group')messages=[msg('g1','GROK_GC_PARITY_20260903_NO_MENTION — each member reply once with exactly its bot name followed by " ACK_NOMENTION".',{},'user'),msg('g2','New Bot ACK_NOMENTION',{},'agent','bot-ops'),msg('g3','Parity Probe v3 ACK_NOMENTION'),msg('g4','@Parity\nGROK_GC_PARITY_20260903_SINGLE_MENTION — reply exactly PARITY_ONLY_ACK.',{},'user'),msg('g5','PARITY_ONLY_ACK'),msg('g6','DM one another.',{},'user'),msg('g7','DMed New Bot; loop closed.'),msg('g8','DMed Parity Probe v3; loop closed.',{},'agent','bot-ops')];
 if(name==='markdown')messages=[msg('text','Parity pass: every SendToUser card type I can fire from this chat.\n\n1. **text** — this bubble (prose, code, lists).\n2. **attachment** — file/media as its own message (next).\n3. **widget** — question card with options (last; ends the turn).\n4. **cursor-agent** — needs a real cloud-agent bcId; none active, so skipping rather than faking one.\n5. **secret-request** / **credential-request** — each ends the turn alone, so I’ll send those right after you dismiss or answer the widget.')];
 if(name==='voice')messages=[];
 if(name==='glass'){
  // Inert transcript reconstructed from 10–11s of the supplied September 21
  // recording. Preserve content and line wrapping during backdrop comparisons.
  messages=[
   msg('glass-greeting','Animation audit only. Reply with one short greeting; do not use tools or take other actions.',{},'user'),
   msg('glass-hey','Hey.'),
   msg('glass-morning-prompt','Animation audit only. Reply with a friendly paragraph of about 80 words about a quiet morning. Do not use tools or take any other action.',{},'user'),
   msg('glass-morning','A quiet morning starts soft. Light slips across the floor before the city wakes, and the kettle clicks with the only real urgency in the room. Coffee cools just enough to taste. Outside, a bird tries a few notes and then thinks better of it. Nothing needs deciding yet—no messages, no plans, just the small comfort of sitting still. For a few minutes the day feels open and unclaimed, and that is enough.'),
   msg('glass-hello-prompt','Animation audit only. Reply only Hello; take no other actions.',{},'user'),
   msg('glass-hello','Hello'),
   msg('glass-final','I need you to test basically every single different type of... different type of custom component that you have, including widgets, custom components, etc. Just send a bunch of them, like every single possible one you can do.',{},'user'),
  ];
  messages.slice(0,-1).forEach(m=>m.createdAt='2026-09-19T22:41:00Z');
  active=true;
 }
 if(name==='opening')messages=[msg('hello','Hello'),msg('prompt','I need you to test basically every single different type of... different type of custom component that you have, including widgets, custom components, etc. Just send a bunch of them, like every single possible one you can do.',{},'user')];
}
reset('single');
const server=Bun.serve({hostname:'127.0.0.1',port:20121,idleTimeout:40,async fetch(req){
 const url=new URL(req.url),path=url.pathname;
 if(path==='/__audit/scene') {const b:any=await req.json();await fetch(upstream+'/__qa/reset',{method:'POST'});reset(b.scene);return Response.json({ok:true});}
 if(path==='/__audit/state')return Response.json({scene,revision,messages,receipts});
 if(path==='/__audit/fail-once'){failOnce=true;return Response.json({ok:true});}
 if(path==='/__audit/lose-next-response'){loseOnce=true;return Response.json({ok:true});}
 if(path==='/__audit/bot-reply'){const b:any=await req.json();messages.push(msg('bot-reply',b.content,{type:'text',replyTo:b.replyTo,branched:true}));revision++;return Response.json({ok:true});}
 if(path==='/__audit/activity-on-answer'){workOnAnswer=true;return Response.json({ok:true});}
 if(path==='/__audit/activity'){active=(await req.json() as any).active;revision++;return Response.json({ok:true});}
 if(path==='/api/v0/events/poll'){await Bun.sleep(200);return Response.json({events:Number(url.searchParams.get('after'))<revision?[{sequence:String(revision),topic:'snapshot.reset',payload:{}}]:[]});}
 if(path.endsWith('/history')){if(delay){await Bun.sleep(12000);delay=false;}return Response.json({channelId:channel,messages,threadContext:[],threadContextTruncated:false,beforeSequence:messages[0]?.sequence,hasMore:false,revision:String(revision)});}
 if(path.endsWith('/context'))return Response.json({channelId:channel,targetMessageId:'root',messages,threadContext:[],threadContextTruncated:false,beforeSequence:messages[0]?.sequence,afterSequence:messages.at(-1)?.sequence,hasMoreBefore:false,hasMoreAfter:false,revision:String(revision)});
 if(path.endsWith('/client-state'))return Response.json({channelId:channel,revision:String(revision),channelRounds:[],runs:active?[{id:'working',botId:'bot-research',channelId:channel,status:'running'}]:[],runItems:[],approvals:[],subagents:[],truncated:{}});
 if(path.endsWith('/widget-response')||path.endsWith('/widget-dismiss')){const b:any=await req.json();receipts.push({path,body:b});const m=messages.find(m=>m.id==='card')!;if(failOnce){failOnce=false;return Response.json({error:{message:'Synthetic retry failure'}},{status:503});}if(m.metadata.respondedValue!==undefined||m.metadata.widgetDismissed)return Response.json({accepted:false,message:m});m.metadata={...m.metadata,...(path.endsWith('/widget-dismiss')?{widgetDismissed:true,widgetDismissClientId:b.clientId}:{respondedValue:b.value,widgetResponseClientId:b.clientId})};revision++;if(workOnAnswer)active=true;if(loseOnce){loseOnce=false;return Response.json({error:{message:'Synthetic lost acknowledgement after commit'}},{status:503});}return Response.json({accepted:true,message:m});}
 if(path.endsWith('/messages')&&req.method==='POST'){const b:any=await req.json();receipts.push({path,body:b});const m=msg('sent-'+revision,b.content,{type:'text',...(b.replyToMessageId?{replyTo:b.replyToMessageId}:{}),...(b.isFork?{branched:true}:{})},'user');m.clientId=b.clientId;messages.push(m);revision++;return Response.json({message:m});}
 if(path==='/api/v0/client-bootstrap'){
  const body:any=await (await fetch(upstream+path)).json();body.cursor=String(revision);body.latestMessages=scene==='opening'?[]:messages;if(scene==='voice')body.runtime.transcription='configured';body.pendingApprovals=[];body.activeRuns=active?[{id:"working",botId:"bot-research",channelId:channel,status:"running"}]:[];
  for(const bot of body.bots){if(bot.id==='bot-research'){bot.name=['reply','thread'].includes(scene)?'Memory Deep 914 Box copy':'Parity Probe v3';bot.color=['reply','thread'].includes(scene)?'#00BBA6':'#0084FF';bot.icon='round';}if(bot.id==='bot-ops'){bot.name='New Bot';bot.color='#9259FE';bot.icon='round';}}
  const chat=body.channels.find((c:any)=>c.id===channel);chat.name=scene==='group'?'Parity Probe Room':body.bots.find((b:any)=>b.id==='bot-research').name;chat.kind=scene==='group'?'group':'direct';if(scene==='group'){chat.members=[{botId:'bot-ops',ordinal:0},{botId:'bot-research',ordinal:1}];const bot=body.bots.find((b:any)=>b.id==='bot-research');bot.dmChannelId='fixture-direct-research';body.channels.push({...chat,id:bot.dmChannelId,kind:'direct',name:bot.name,members:[{botId:bot.id,ordinal:0}]});}
  return Response.json(body);
 }
 const data=await req.arrayBuffer();return fetch(upstream+path+url.search,{method:req.method,headers:req.headers,...(data.byteLength?{body:data}:{})});
}});console.log('matched-fixture',server.port);
