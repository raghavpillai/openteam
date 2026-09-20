/** Authenticated API passthrough with explicit, bounded network-failure injection. */
const base='http://127.0.0.1:20020', control='http://127.0.0.1:20022', desktop='http://127.0.0.1:20025';
const botID=process.env.SWIFT_VNC_QA_BOT_ID;
if(!botID)throw new Error('SWIFT_VNC_QA_BOT_ID required');
let faults={offline:false,vncDelay:0,statusDelay:0,actionFailures:0,takeoverFailures:0};
const receipts:any[]=[];
type Relay = { upstream: WebSocket; queued: Uint8Array[]; bytes: number; client?: any };
const connections = new Set<Relay>();
const safeStatus=(value:any)=>{const {viewerUrl,...safe}=value;return safe};
Bun.serve<Relay>({hostname:'127.0.0.1',port:20024,idleTimeout:60,
 websocket: {
  open(client) {
   const state=client.data;state.client=client;connections.add(state);
   state.upstream.addEventListener('open',()=>{for(const bytes of state.queued)state.upstream.send(bytes);state.queued=[];state.bytes=0;});
   state.upstream.addEventListener('message',event=>{if(event.data instanceof ArrayBuffer)client.send(event.data);});
   state.upstream.addEventListener('close',()=>client.close(1012));
   state.upstream.addEventListener('error',()=>client.close(1013));
  },
  message(client,message){
   if(typeof message==='string'){client.close(1003);return}
   const state=client.data;
   if(state.upstream.readyState===WebSocket.OPEN)state.upstream.send(message);
   else if((state.bytes+=message.byteLength)>128*1024)client.close(1009);
   else state.queued.push(new Uint8Array(message));
  },
  close(client){connections.delete(client.data);client.data.upstream.close();},
 },
 async fetch(request,server){
 const url=new URL(request.url);if(request.headers.has('origin')&&!['null','file://'].includes(request.headers.get('origin')!))return new Response(null,{status:403});
 if(url.pathname==='/__qa/config'){
  const config=await (await fetch(control+'/config')).json();
  const bootstrap=await (await fetch(control+'/api/v0/client-bootstrap')).json();
  const bot=bootstrap.bots.find((bot:any)=>bot.id===botID);
  if(!bot)throw new Error('QA bot is missing from bootstrap');
  return Response.json({...config,base:'http://127.0.0.1:20024',botID,channel:bot.dmChannelId},{headers:{'cache-control':'no-store'}});
 }
 if(url.pathname==='/__qa/control'&&request.method==='POST'){faults={...faults,...await request.json()};if(faults.offline){for(const c of connections){c.client?.close(1012);c.upstream.close();}}return Response.json({ok:true})}
 if(url.pathname==='/__qa/reset'&&request.method==='POST'){
  faults={offline:false,vncDelay:0,statusDelay:0,actionFailures:0,takeoverFailures:0};receipts.length=0;
  await fetch(control+'/api/v0/bots/'+botID+'/screen/takeover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({active:false})});
  await fetch(desktop+'/reset',{method:'POST'});return Response.json({ok:true});
 }
 if(url.pathname==='/__qa/state')return Response.json({desktop:await(await fetch(desktop+'/state')).json(),status:safeStatus(await(await fetch(control+'/api/v0/bots/'+botID+'/screen')).json()),receipts});
 if(url.pathname==='/__qa/focus'||url.pathname==='/__qa/desktop')return fetch(desktop+url.pathname.replace('/__qa',''),{method:'POST'});
 if(url.pathname==='/__qa/release')return fetch(control+'/api/v0/bots/'+botID+'/screen/takeover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({active:false})});
 const screen=url.pathname.includes('/screen');
 if(faults.offline)return Response.json({message:'QA network interruption; retry when reconnected'},{status:503});
 if(screen&&url.pathname.endsWith('/vnc')) {
  if(faults.vncDelay)await Bun.sleep(faults.vncDelay);
  if(request.method==='GET'&&request.headers.get('upgrade')?.toLowerCase()==='websocket') {
   const upstream=new WebSocket(base.replace(/^http/,'ws')+url.pathname,request.headers.get('sec-websocket-protocol')?.split(',').map(v=>v.trim())??[]);
   upstream.binaryType='arraybuffer';
   if(server.upgrade(request,{data:{upstream,queued:[],bytes:0},headers:{'sec-websocket-protocol':'openteam-vnc'}}))return;
   upstream.close();return new Response(null,{status:400});
  }
 }
 if(screen&&url.pathname.endsWith('/screen')&&faults.statusDelay)await Bun.sleep(faults.statusDelay);
 const body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
 const input=body?.byteLength?JSON.parse(new TextDecoder().decode(body)):undefined;
 let rejected=false;
 if(request.method==='POST'&&url.pathname.endsWith('/actions')&&faults.actionFailures>0){faults.actionFailures--;rejected=true}
 if(request.method==='POST'&&url.pathname.endsWith('/takeover')&&faults.takeoverFailures>0){faults.takeoverFailures--;rejected=true}
 const started=Date.now();
 const response=rejected?Response.json({message:'QA input failed; please try again'},{status:503}):await fetch(base+url.pathname+url.search,{method:request.method,headers:request.headers,body});
 if(screen){receipts.push({path:url.pathname,method:request.method,input,status:response.status,elapsed:Date.now()-started,time:Date.now(),injected:rejected});if(receipts.length>500)receipts.shift()}
 return response;
}});
console.log('Live native VNC QA proxy on 20024');
