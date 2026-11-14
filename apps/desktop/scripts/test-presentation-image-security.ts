// Regression against the actual production App/AuthGate/presentation chunk.
// Serve only owned API/photo fixtures and intercept every external destination.
// Run after desktop build: bun apps/desktop/scripts/test-presentation-image-security.ts --reuse
import {parsePresentation,PresentationSchema,PresentationInputSchema,presentationReferences,resolvePresentationReferences,presentationFallback} from "@openteam/contracts/presentation";
import { build } from 'vite';
import { chromium } from '../../computer/node_modules/playwright-core';
import { mobileFixture } from '../../ios/scripts/fixtures/snapshot';
import { CLIENT_CAPABILITIES } from '@openteam/contracts/capabilities';
import { emptySidebarPreferences } from '@openteam/contracts/client-preferences';
import { ServerSetupFixture } from '../../ios/scripts/server-setup-fixture';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const root=resolve(import.meta.dir, '..');
const out=process.env.OPENTEAM_PRESENTATION_IMAGE_OUTPUT ?? resolve(root, '../../output/presentation-image-security');
await mkdir(out,{recursive:true});
if(!process.argv.includes('--reuse')) await build({root,configFile:join(root,'vite.config.ts'),cacheDir:join(out,'vite-cache'),build:{outDir:join(out,'dist'),emptyOutDir:true}});
const requests:any[]=[],checks:any[]=[],errors:any[]=[],unexpected:any[]=[];
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=','base64');
let authMode='disabled',sessionAccount='A',failCreate=false,slowLibrary=false;
const setup=new ServerSetupFixture(true);
const runtime={server:'ready',database:'ready',queue:'ready',computer:'ready',inference:'ready',transcription:'configured'};
const makeMessage=(channelId:string,id:string,content:string,metadata:any={})=>({id,channelId,sequence:'1',sender:'agent',senderBotId:channelId==='channel-research'?'bot-research':'bot-ops',sourceRunId:null,content,metadata,createdAt:'2026-11-11T10:00:00Z'});
let bots:any[]=[],channels:any[]=[],messages:any[]=[];
let generation=0,control:any=null;
function reset(){
 bots=structuredClone(mobileFixture.bots.slice(0,2));channels=structuredClone(mobileFixture.channels.slice(0,2));
 for(const c of channels)c.unreadCount=0;
 messages=[makeMessage(channels[0].id,'message-base','Production entry synthetic response'),{...makeMessage(channels[0].id,'message-user','Unsent continuity control'),sequence:'2',sender:'user',senderBotId:null},makeMessage(channels[1].id,'message-other','Other channel protected content')];control=null;
}
reset();
const attachment=(id:string,name:string,mime='text/plain')=>({assetId:id.repeat(64),fileName:name,mimeType:mime,kind:mime.startsWith('image/')?'image':'file',byteSize:100});
const libraryItem=(id:string,name:string)=>({id:id.repeat(64),messageId:'message-base',createdAt:'2026-11-11T10:00:00Z',attachment:attachment(id,name)});
const screen=(botId='bot-research')=>({botId,state:'ready',width:1280,height:800,humanTakeover:!!control,controlSession:control,controlPending:false});
const json=(v:any)=>Response.json(v);
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const u=new URL(req.url),p=u.pathname;let body:any=null;
 if(req.method!=='GET')body=await req.json().catch(()=>null);
 if(p.startsWith('/api/'))requests.push({method:req.method,path:p,query:u.search,body,authorization:req.headers.get('authorization'),at:Date.now()});
 if(p==='/api/v0/presentation-image') {
  const provider=new URL(u.searchParams.get('url')!);
  return provider.hostname==='photo.qa.invalid' ? new Response(photo,{headers:{'content-type':'image/png','x-content-type-options':'nosniff','cache-control':'no-store'}}) : new Response(null,{status:422});
 }
 if(p==='/api/auth/config')return json({mode:authMode});
 if(p==='/api/auth/get-session')return json({session:{id:'synthetic-session'},user:{id:sessionAccount,name:'QA '+sessionAccount,username:'qa'+sessionAccount,email:'qa@example.invalid'}});
 if(p==='/api/v0/client-bootstrap')return json({cursor:'100',workspace:mobileFixture.workspace,bots,channels,latestMessages:channels.map(c=>messages.filter(m=>m.channelId===c.id).at(-1)).filter(Boolean),activeRuns:[],channelRounds:[],subagents:[],runtime,capabilities:CLIENT_CAPABILITIES});
 if(p==='/api/v0/client-runtime')return json({runtime});
 if(p==='/api/v0/active-agent')return json({activeAgentId:bots[0]?.id??null});
 if(p==='/api/v0/settings')return json({valid:true,settings:{sidebarPreferences:emptySidebarPreferences()}});
 if(p==='/api/v0/notification-presence')return json({});
 if(p==='/api/v0/events')return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': connected\n\n'));}}),{headers:{'content-type':'text/event-stream'}});
 if(p==='/api/v0/search')return json({results:bots.filter(b=>b.name.toLowerCase().includes((u.searchParams.get('q')??'').toLowerCase())).map(b=>({id:b.id,kind:'bot',title:b.name,subtitle:'Synthetic',botId:b.id,channelId:b.dmChannelId,createdAt:b.createdAt}))});
 const match=p.match(/^\/api\/v0\/channels\/([^/]+)\/(history|client-state|library|read)$/);
 if(match){const[,id,kind]=match;
  if(kind==='history')return json({channelId:id,messages:messages.filter(m=>m.channelId===id),threadContext:[],threadContextTruncated:false,beforeSequence:null,hasMore:false,revision:'100'});
  if(kind==='client-state')return json({channelId:id,revision:'100',channelRounds:[],runs:[],runItems:[],subagents:[],truncated:{channelRounds:false,runs:false,runItems:false,subagents:false}});
  if(kind==='read')return json({channelId:id,lastReadSequence:'100',unreadCount:0});
  if(kind==='library'){const owner=sessionAccount;const response={items:[libraryItem(id==='channel-research'?'a':'b',owner+'-'+id+'.txt')],nextCursor:null}; if(slowLibrary&&id==='channel-research')await Bun.sleep(700);return json(response);}
 }
 if(p.startsWith('/api/v0/assets/'))return new Response('Synthetic library preview content for '+sessionAccount,{headers:{'content-type':'text/plain'}});
 if(p==='/api/v0/bots'&&req.method==='POST'){
  if(failCreate){failCreate=false;return new Response(JSON.stringify({error:{message:'Synthetic create failure'}}),{status:400,headers:{'content-type':'application/json'}});}
  const bot={...bots[0],...body,id:'bot-created',dmChannelId:'channel-created',conversationId:'conversation-created'};bots.push(bot);channels.push({...channels[0],id:bot.dmChannelId,name:bot.name,members:[{botId:bot.id,ordinal:0}]});return json(bot);
 }
 if(/^\/api\/v0\/bots\/[^/]+$/.test(p)&&req.method==='DELETE'){const id=p.split('/').at(-1);const b=bots.find(b=>b.id===id);bots=bots.filter(b=>b.id!==id);channels=channels.filter(c=>c.id!==b?.dmChannelId);messages=messages.filter(m=>m.channelId!==b?.dmChannelId);return json({deleted:true,botId:id});}
 if(/^\/api\/v0\/channels\/[^/]+$/.test(p)&&req.method==='DELETE'){const id=p.split('/').at(-1);channels=channels.filter(c=>c.id!==id);messages=messages.filter(m=>m.channelId!==id);return json({deleted:true,channelId:id});}
 if(p.endsWith('/screen/status')||/^\/api\/v0\/bots\/[^/]+\/screen$/.test(p))return json(screen(p.split('/')[4]));
 if(p.endsWith('/screen/takeover')){if(body.active)control={id:body.controlId,generation:++generation};else if(body.force||body.controlId===control?.id)control=null;return json(screen(p.split('/')[4]));}
 if(p.endsWith('/screen/vnc'))return new Response(JSON.stringify({error:{message:'Synthetic VNC transport unavailable'}}),{status:503,headers:{'content-type':'application/json'}});
 if(p.endsWith('/screen/frame'))return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=','base64'),{headers:{'content-type':'image/png'}});
 if(p.endsWith('/computer-handoff')){const id=p.split('/')[4];const m=messages.find(m=>m.id===id);const state=body.action==='start'?'active':body.action==='complete'?'completed':body.action==='skip'?'skipped':'dismissed';m.metadata={...m.metadata,computerHandoffState:state};control=body.action==='start'?{id:'handoff:'+id,generation:++generation}:null;return json({accepted:true,message:m});}
 if(p.endsWith('/user-form/dismiss')){const id=p.split('/')[4];const m=messages.find(m=>m.id===id);m.metadata={...m.metadata,cardState:body.mode??'escalated'};control={id:'handoff:'+id,generation:++generation};return json({accepted:true,message:m});}
 if(p.endsWith('/user-form/prefill'))return json({});
 if(p.endsWith('/routines'))return json([]);
 if(p.endsWith('/plugins/composer'))return json({items:[]});
 const setupResponse=setup.handle(p,req.method,body,u);if(setupResponse)return setupResponse;
 if(p.startsWith('/api/')){unexpected.push({method:req.method,path:p});return new Response(JSON.stringify({error:{message:'Fixture endpoint absent '+p}}),{status:404,headers:{'content-type':'application/json'}});}
 const file=Bun.file(join(root,'dist',p==='/'?'index.html':p.slice(1)));return await file.exists()?new Response(file):new Response(null,{status:404});
}});
const browser=await chromium.launch({executablePath:process.env.OPENTEAM_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:1456,height:924},acceptDownloads:true});
const external:any[]=[];
await context.route('**/*',async route=>{
 const u=new URL(route.request().url());
 if(u.origin===server.url.origin||u.protocol==='blob:'||u.protocol==='data:')return route.continue();
 external.push({url:u.href,type:route.request().resourceType(),headers:route.request().headers()});
 if(u.pathname.endsWith('.pbf'))return route.fulfill({contentType:'application/x-protobuf',body:Buffer.alloc(0)});
 if(u.hostname==='tiles.openfreemap.org'&&u.pathname.endsWith('.png'))return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=','base64')});
 if(u.hostname.endsWith('.qa.invalid')||['127.0.0.1','192.168.1.1','[::1]','169.254.169.254','printer.local'].includes(u.hostname))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="teal"/></svg>'});
 if(u.hostname==='tiles.openfreemap.org'&&u.pathname.includes('/planet'))return route.fulfill({contentType:'application/json',body:JSON.stringify({tilejson:'3.0.0',tiles:['https://tiles.qa.invalid/{z}/{x}/{y}.pbf'],minzoom:0,maxzoom:14,vector_layers:[]})});
 if(u.pathname.endsWith('.pbf'))return route.fulfill({contentType:'application/x-protobuf',body:Buffer.alloc(0)});
 if(u.pathname.endsWith('.json'))return route.fulfill({contentType:'application/json',body:'{}'});
 return route.abort();
});
const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 localStorage.setItem('openteam:selected-channel','channel-research');localStorage.setItem('openteam:theme','light');
});
const check=(ok:any,label:string,detail?:any)=>{checks.push({label,pass:!!ok,detail});if(!ok)throw Error(label+': '+JSON.stringify(detail));};
const scenario=async(name:string,fn:()=>Promise<void>)=>{try{await fn();console.log('PASS',name)}catch(e){checks.push({scenario:name,pass:false,error:String(e)});console.error('FAIL',name,e);await page.screenshot({path:join(out,name.replace(/[^a-z0-9]/gi,'-')+'-failure.png')}).catch(()=>{});}await writeFile(join(out,'results.json'),JSON.stringify({checks,errors,unexpected,requests},null,2));};
const load=async()=>{await page.goto(server.url.origin);await page.locator('[data-chat-layout-ready="true"]').waitFor();};
const details=async()=>{if(!await page.getByRole('button',{name:'Close details',exact:true}).isVisible().catch(()=>false))await page.getByRole('button',{name:'View conversation details',exact:true}).first().click();await page.getByRole('tab',{name:'Library',exact:true}).waitFor();};

const base:any={version:1,places:[{id:'p1',name:'QA Place One',latitude:40.7,longitude:-74,imageUrl:'https://photo.qa.invalid/one.svg'},{id:'p2',name:'QA Place Two',latitude:40.71,longitude:-74.01,imageUrl:'https://photo.qa.invalid/two.svg'}],blocks:[{type:'place_map',title:'QA Map',placeIds:['p1','p2']},{type:'ranked_media_list',title:'QA ranked places',items:[{id:'r1',title:'First owned place',placeId:'p1'},{id:'r2',title:'Second owned place',placeId:'p2'}]}]};
await scenario('structured-payload-validation',async()=>{
 check(PresentationSchema.safeParse(base).success,'valid coordinates and ranked place references accepted');
 for(const [name,mutate] of Object.entries({nan:(v:any)=>v.places[0].latitude=NaN,range:(v:any)=>v.places[0].longitude=181,duplicate:(v:any)=>v.places[1].id='p1',missing:(v:any)=>v.blocks[0].placeIds=['missing'],rankMissing:(v:any)=>v.blocks[1].items[0].placeId='missing',duplicateStops:(v:any)=>v.blocks[0].placeIds=['p1','p1'],javascript:(v:any)=>v.places[0].imageUrl='javascript:alert(1)',credentials:(v:any)=>v.places[0].imageUrl='https://u:p@photo.qa.invalid/a'})){
 const v=structuredClone(base);mutate(v);check(!PresentationSchema.safeParse(v).success,'reject '+name);
 }
 const input=structuredClone(base);input.places=['p1',{id:'p2',notes:'own notes'}];check(PresentationInputSchema.safeParse(input).success,'ID input accepted');const resolved=resolvePresentationReferences(input,new Map(base.places.map(p=>[p.id,p])),new Map());check(parsePresentation(resolved).places[1].notes==='own notes','ID resolution preserves own notes');
 let rejected=false;try{parsePresentation(input)}catch{rejected=true}check(rejected,'unresolved references rejected at display boundary');
});
await scenario('production-map-ranked-render-and-dialog',async()=>{
 reset();const presentation=parsePresentation(base);messages=[makeMessage('channel-research','map-fixture',presentationFallback(presentation),{type:'presentation',presentation})];await load();await page.getByRole('button',{name:'Open map full screen'}).waitFor();
 await page.locator('.ranked-media-copy h4').filter({hasText:'First owned place'}).waitFor();check(await page.locator('.ranked-media-copy h4').filter({hasText:'First owned place'}).isVisible(),'ranked item renders reference image and title');
 await page.waitForFunction(()=>[...document.querySelectorAll('.place-thumbnail')].some((x:any)=>x.tagName==='IMG'&&x.src.startsWith('blob:')&&x.complete&&x.naturalWidth===1));
 check(await page.locator('.place-thumbnail[src^="blob:"]').count()>0,'normal public photo displays from selected server blob');
 check(requests.some(r=>r.path==='/api/v0/presentation-image'),'public photos use protected image API');
 await page.getByRole('button',{name:'View details for QA Place One'}).click();await page.getByRole('button',{name:'Close place details'}).waitFor();check(await page.locator('.place-detail').count()>0,'place details opens');await page.getByRole('button',{name:'Close place details'}).click();await page.getByRole('button',{name:'Close place details'}).waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Open map full screen'}).click();await page.getByRole('button',{name:'Close map',exact:true}).waitFor();await page.screenshot({path:join(out,'fullscreen.png')});check(await page.locator('.maplibregl-canvas').count()>0,'vector map canvas created with intercepted fixture source');await page.keyboard.press('Escape');await page.getByRole('button',{name:'Close map',exact:true}).waitFor({state:'hidden'});
 await page.screenshot({path:join(out,'inline.png')});
});
await scenario('private-image-url-boundary-original',async()=>{
 const privateUrls=['https://127.0.0.1:54321/private.png','https://192.168.1.1/private.png','https://printer.local/private.png','https://169.254.169.254/private.png','https://[::1]/private.png'];
 const accepted=privateUrls.map(imageUrl=>{const p=structuredClone(base);p.places[0].imageUrl=imageUrl;return{imageUrl,accepted:PresentationSchema.safeParse(p).success}});await writeFile(join(out,'private-validation.json'),JSON.stringify(accepted,null,2));
 const p=structuredClone(base);p.blocks=[{type:'ranked_media_list',title:'Private target probe',items:privateUrls.map((imageUrl,i)=>({id:'private-'+i,title:'Private fixture '+i,imageUrl}))}];messages=[makeMessage('channel-research','private-map',presentationFallback(parsePresentation(p)),{type:'presentation',presentation:p})];await load();await page.locator('.ranked-media-copy h4').filter({hasText:'Private fixture 0'}).waitFor();await page.waitForTimeout(600);const hits=external.filter(x=>privateUrls.includes(x.url));await writeFile(join(out,'private-requests.json'),JSON.stringify(hits,null,2));
 check(hits.length===0,'private images must not be requested automatically',hits);
});
await scenario('malformed-render-fallback',async()=>{const p=structuredClone(base);p.blocks[0].placeIds=['missing'];messages=[makeMessage('channel-research','malformed-map','Safe malformed presentation fallback',{type:'presentation',presentation:p})];await load();await page.getByLabel('timeline entries').getByText('Safe malformed presentation fallback',{exact:true}).waitFor();check(!await page.locator('.maplibregl-map').count(),'malformed references render fallback without crashing')});
await writeFile(join(out,'results.json'),JSON.stringify({checks,errors,unexpected,requests,external},null,2));await browser.close();await server.stop(true);console.log(JSON.stringify({checks,errors,unexpected},null,2));if(checks.some(c=>!c.pass))process.exitCode=1;
