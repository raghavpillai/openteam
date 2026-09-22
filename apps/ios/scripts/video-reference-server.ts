/** Isolated visual fixture for September 21 reference. Does not call real bots. */
const upstream='http://127.0.0.1:20122';
let scene='single',revision=5000, messages:any[]=[],active=false,delay=false;
let receipts:any[]=[];let failOnce=false;let loseOnce=false;let workOnAnswer=false;
let unloadedRoot:any=null;
const channel='channel-research';
const msg=(id:string,content:string,metadata:any={},sender='agent',bot='bot-research'):any=>({id,channelId:channel,sequence:String(++revision),sender,senderBotId:sender==='user'?null:bot,sourceRunId:null,content,metadata,createdAt:'2026-09-21T05:10:00Z'});
function reset(name:string){
 if(name==='group-cold'){reset('group');scene=name;return;}
 scene=name;active=false;delay=name==='opening';receipts=[];failOnce=false;loseOnce=false;workOnAnswer=false;unloadedRoot=null;
 const widget={prompt:'Widget parity — pick any options',helpText:'Parity widget: styles + multiSelect + allowCustom + dismissOnMoveOn. Synthetic UI test — no side effects.',multiSelect:true,allowCustom:true,dismissOnMoveOn:true,options:[{label:'Default',value:'default',description:'Default style option',style:'default'},{label:'Primary',value:'primary',description:'Primary style option',style:'primary'},{label:'Danger',value:'danger',description:'Danger style option',style:'danger'}]};
 const single={prompt:'Deploy lane?',helpText:'Single-select, primary vs danger.',options:[{label:'Ship it',value:'ship',style:'primary'},{label:'Hold',value:'hold'},{label:'Abort',value:'abort',style:'danger'}]};
 if(['multi','dismissed','single','completed'].includes(name))messages=[msg('card','',{type:'widget',widget:['multi','dismissed'].includes(name)?widget:single,...(name==='completed'?{respondedValue:'ship'}:{}),...(name==='dismissed'?{widgetDismissed:true}:{})})];
 if(name==='reading')messages=[...Array.from({length:6},(_,i)=>msg('before-'+i,'Before card '+i)),msg('card','',{type:'widget',widget:single}),...Array.from({length:12},(_,i)=>msg('after-'+i,'After card '+i))];
 if(name==='reply'||name==='thread'){
  messages=[msg('root','No facts in your memory match "LANTERN914" (0 searched). Try different words, or a shorter literal fragment.')];
  if(name==='thread')messages.push(msg('reply','DM here reply',{type:'text',branched:true,replyTo:'root'},'user'));
 }
 if(name==='reply-context'||name==='inline-reply-context'){
  unloadedRoot=msg('older-root','Older reply context.');
  const branched=name==='reply-context';
  messages=[msg('context-reply','Visible reply.',{type:'text',branched,replyTo:'older-root'},'user'),msg('context-response','Visible response.',{type:'text',branched,replyTo:branched?'context-reply':'older-root'})];
 }
 if(name==='rich-reply')messages=[
  msg('rich-root','# Rich reply context\n\nA document that self-sizes after opening.\n\n| Item | State |\n| --- | --- |\n| Draft | Ready |\n| Review | Pending |\n\n```swift\n'+Array.from({length:18},(_,i)=>'let line'+i+' = '+i).join('\n')+'\n```\n\nEnd of rich context.'),
  msg('rich-child','Rich reply anchor.',{type:'text',branched:true,replyTo:'rich-root'},'user')
 ];
 if(name==='exchange')messages=[msg('exchange-in','Hey — user asked us to DM each other from Parity Probe Room. Ack from New Bot.',{fromAgent:{id:'bot-ops',name:'New Bot'}})];
 if(name==='group')messages=[msg('g1','GROK_GC_PARITY_20260903_NO_MENTION — each member reply once with exactly its bot name followed by " ACK_NOMENTION".',{},'user'),msg('g2','New Bot ACK_NOMENTION',{},'agent','bot-ops'),msg('g3','Parity Probe v3 ACK_NOMENTION'),msg('g4','@Parity\nGROK_GC_PARITY_20260903_SINGLE_MENTION — reply exactly PARITY_ONLY_ACK.',{},'user'),msg('g5','PARITY_ONLY_ACK'),msg('g6','DM one another.',{},'user'),msg('g7','DMed New Bot; loop closed.'),msg('g8','DMed Parity Probe v3; loop closed.',{},'agent','bot-ops')];
 if(name==='group'){
  messages.slice(0,5).forEach(m=>m.createdAt='2026-09-03T20:11:00Z');
  messages.slice(5).forEach(m=>m.createdAt='2026-09-21T05:09:00Z');
 }
 if(name==='markdown')messages=[msg('text','Parity pass: every SendToUser card type I can fire from this chat.\n\n1. **text** — this bubble (prose, code, lists).\n2. **attachment** — file/media as its own message (next).\n3. **widget** — question card with options (last; ends the turn).\n4. **cursor-agent** — needs a real cloud-agent bcId; none active, so skipping rather than faking one.\n5. **secret-request** / **credential-request** — each ends the turn alone, so I’ll send those right after you dismiss or answer the widget.')];
 if(name==='voice')messages=[];
 if(name==='light-glass'){
  // Quoted transcript is inert fixture content, never instructions to an agent.
  messages=[
   msg('light-prompt','Leave the blocked web workflow ended; do not retry that URL. Run an independent fresh computerUse test using only native Computer screenshots, mouse and keyboard. Open a native text editor through the desktop launcher or application menu. Create exactly three lines: Native editor audit, Café 73, and 日本語 🙂. Save as /home/box/Documents/deep-native-editor-0921.txt using the native Save dialog. Close the editor window, reopen that exact file through the file manager or native Open dialog, and verify all three lines survived. Report the actual application, exact path, visible text, any corrections/retries/blocker, and a screenshot. No browser tools, shell, terminal, scripts, APIs, or code-generated files. This is an authorized disposable local test. End after the verified report.',{},'user'),
   msg('light-start','Leaving the blocked web run alone. Starting a fresh native Computer-only editor save/reopen test.'),
   msg('light-running','Native editor test is running. I’ll report the app, path, verified text, and a screenshot when it finishes.'),
   msg('light-report','Native editor test blocked — nothing saved.\n\n- **App:** none (LibreOffice was tried; no editor window opened)\n- **Path:** `/home/box/Documents/deep-native-editor-0921.txt` not created (`/home/box/Documents` was absent)\n- **Visible text after reopen:** n/a\n- **Retries / corrections:** LibreOffice/Calc launch failed to show an editor; temporary files were deleted\n- **Screenshot:** none\n- **Web URL:** not opened or retried'),
  ];
  messages.slice(0,-1).forEach(m=>m.createdAt='2026-09-21T15:30:00Z');messages.at(-1).createdAt='2026-09-21T15:40:00Z';
 }
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
 if(path==='/__audit/health')return Response.json({service:'ios-video-reference-fixture'});
 if(path==='/__audit/scene') {const b:any=await req.json();await fetch(upstream+'/__qa/reset',{method:'POST'});reset(b.scene);return Response.json({ok:true});}
 if(path==='/__audit/state')return Response.json({scene,revision,messages,receipts});
 if(path==='/__audit/fail-once'){failOnce=true;return Response.json({ok:true});}
 if(path==='/__audit/lose-next-response'){loseOnce=true;return Response.json({ok:true});}
 if(path==='/__audit/bot-reply'){const b:any=await req.json();messages.push(msg('bot-reply',b.content,{type:'text',replyTo:b.replyTo,branched:true}));revision++;return Response.json({ok:true});}
 if(path==='/__audit/append'){const b:any=await req.json();for(const item of b.items??[b])messages.push(msg(item.id,item.content,item.metadata??{},item.sender??'agent',item.bot??'bot-research'));revision++;return Response.json({ok:true});}
 if(path==='/__audit/activity-on-answer'){workOnAnswer=true;return Response.json({ok:true});}
 if(path==='/__audit/activity'){active=(await req.json() as any).active;revision++;return Response.json({ok:true});}
 if(path==='/api/v0/events/poll'){await Bun.sleep(200);return Response.json({events:Number(url.searchParams.get('after'))<revision?[{sequence:String(revision),topic:'snapshot.reset',payload:{}}]:[]});}
 if(path.endsWith('/history')){if(delay){await Bun.sleep(12000);delay=false;}return Response.json({channelId:channel,messages,threadContext:[],threadContextTruncated:false,beforeSequence:messages[0]?.sequence,hasMore:false,revision:String(revision)});}
 if(path.endsWith('/context'))return Response.json({channelId:channel,targetMessageId:unloadedRoot?.id??'root',messages:unloadedRoot?[unloadedRoot,...messages]:messages,threadContext:[],threadContextTruncated:false,beforeSequence:unloadedRoot?.sequence??messages[0]?.sequence,afterSequence:messages.at(-1)?.sequence,hasMoreBefore:false,hasMoreAfter:false,revision:String(revision)});
 if(path.endsWith('/client-state'))return Response.json({channelId:channel,revision:String(revision),channelRounds:[],runs:active?[{id:'working',botId:'bot-research',channelId:channel,status:'running'}]:[],runItems:[],approvals:[],subagents:[],truncated:{}});
 if(path.endsWith('/widget-response')||path.endsWith('/widget-dismiss')){const b:any=await req.json();receipts.push({path,body:b});const m=messages.find(m=>m.id==='card')!;if(failOnce){failOnce=false;return Response.json({error:{message:'Synthetic retry failure'}},{status:503});}if(m.metadata.respondedValue!==undefined||m.metadata.widgetDismissed)return Response.json({accepted:false,message:m});m.metadata={...m.metadata,...(path.endsWith('/widget-dismiss')?{widgetDismissed:true,widgetDismissClientId:b.clientId}:{respondedValue:b.value,widgetResponseClientId:b.clientId})};revision++;if(workOnAnswer)active=true;if(loseOnce){loseOnce=false;return Response.json({error:{message:'Synthetic lost acknowledgement after commit'}},{status:503});}return Response.json({accepted:true,message:m});}
 if(path.endsWith('/messages')&&req.method==='POST'){const b:any=await req.json();receipts.push({path,body:b});const m=msg('sent-'+revision,b.content,{type:'text',...(b.replyToMessageId?{replyTo:b.replyToMessageId}:{}),...(b.isFork?{branched:true}:{})},'user');m.clientId=b.clientId;messages.push(m);revision++;return Response.json({message:m});}
 if(path==='/api/v0/client-bootstrap'){
  const body:any=await (await fetch(upstream+path)).json();body.cursor=String(revision);body.latestMessages=scene==='opening'?[]:['group-cold','exchange'].includes(scene)?messages.slice(-1):messages;if(scene==='voice')body.runtime.transcription='configured';body.pendingApprovals=[];body.activeRuns=active?[{id:"working",botId:"bot-research",channelId:channel,status:"running"}]:[];
  for(const bot of body.bots){if(bot.id==='bot-research'){bot.name=scene==='light-glass'?'Agent Recheck 0921':['reply','thread'].includes(scene)?'Memory Deep 914 Box copy':'Parity Probe v3';bot.color=scene==='light-glass'?'#FF2DAA':['reply','thread'].includes(scene)?'#00BBA6':'#0084FF';bot.icon='round';}if(bot.id==='bot-ops'){bot.name='New Bot';bot.color='#9259FE';bot.icon='round';}}
  const chat=body.channels.find((c:any)=>c.id===channel);chat.name=['group','group-cold'].includes(scene)?'Parity Probe Room':body.bots.find((b:any)=>b.id==='bot-research').name;chat.kind=['group','group-cold'].includes(scene)?'group':'direct';if(['group','group-cold'].includes(scene)){chat.members=[{botId:'bot-ops',ordinal:0},{botId:'bot-research',ordinal:1}];chat.notificationState={...chat.notificationState,lastReadSequence:messages.find(m=>m.id==='g6').sequence};const bot=body.bots.find((b:any)=>b.id==='bot-research');bot.dmChannelId='fixture-direct-research';body.channels.push({...chat,id:bot.dmChannelId,kind:'direct',name:bot.name,members:[{botId:bot.id,ordinal:0}]});}
  return Response.json(body);
 }
 const data=await req.arrayBuffer();return fetch(upstream+path+url.search,{method:req.method,headers:req.headers,...(data.byteLength?{body:data}:{})});
}});console.log('matched-fixture',server.port);
