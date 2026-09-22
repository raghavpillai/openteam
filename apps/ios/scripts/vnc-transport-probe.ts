/** Run in the isolated desktop container. Viewer credential arrives only on stdin. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
if(process.env.SWIFT_QA_DISPOSABLE_COMPUTER!=='1')throw new Error('Disposable computer required');
const config=JSON.parse(readFileSync(0,'utf8'));
const url=new URL(config.viewerUrl);url.hostname='127.0.0.1';
const browser=await chromium.launch({executablePath:'/usr/local/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
const results:any={transport:'real RFB over WebSocket via current noVNC viewer',checks:{}};
let view:any;const diagnostics:string[]=[];
try{
 view=await browser.newPage({viewport:{width:1280,height:800}});
 view.on('console',(event:any)=>diagnostics.push(event.type()+': '+event.text()));view.on('pageerror',(error:any)=>diagnostics.push(String(error)));
 await view.addInitScript("window.qaSockets=[]; const NativeSocket=window.WebSocket; window.WebSocket=new Proxy(NativeSocket,{construct(target,args){const socket=Reflect.construct(target,args);window.qaSockets.push(socket);return socket;}});");
 await view.goto(url.toString());await view.waitForSelector('[data-connection-state="connected"]',{timeout:20000});results.checks.authenticatedConnection=true;
 results.checks.credentialRemovedFromURL=!(await view.evaluate(()=>location.hash));
 await fetch('http://127.0.0.1:8791/reset',{method:'POST'});await view.waitForTimeout(700);
 const frames=new Set<string>();for(let i=0;i<12;i++){frames.add(await view.locator('canvas').evaluate((c:HTMLCanvasElement)=>c.toDataURL()));await view.waitForTimeout(250)}
 results.uniqueFramesInThreeSeconds=frames.size;results.checks.liveFrameUpdates=frames.size>=4;
 await fetch('http://127.0.0.1:8791/reset',{method:'POST'});
 await view.mouse.click(400,150);await view.keyboard.type('VNC transport input');
 for(let i=0;i<30;i++){const s:any=await(await fetch('http://127.0.0.1:8791/state')).json();if(s.text==='VNC transport input'){results.checks.keyboardReachedRemote=true;break}await view.waitForTimeout(100)}
 const before:any=await(await fetch('http://127.0.0.1:8791/state')).json();await view.mouse.click(640,560,{button:'right'});await view.waitForTimeout(400);
 const after:any=await(await fetch('http://127.0.0.1:8791/state')).json();results.checks.rightClickReachedRemote=after.rightClicks===before.rightClicks+1;
 await view.evaluate(()=>(window as any).qaSockets.at(-1).close());
 await view.waitForSelector('[data-connection-state="reconnecting"]',{timeout:5000});
 await view.waitForSelector('[data-connection-state="connected"]',{timeout:15000});results.checks.disconnectReconnect=true;
 await view.reload();await view.waitForSelector('[data-connection-state="connected"]',{timeout:15000});results.checks.refreshReconnect=true;
 const readonly=await browser.newPage({viewport:{width:1280,height:800}});const readonlyURL=new URL(url);readonlyURL.searchParams.set('view_only','true');await readonly.goto(readonlyURL.toString());await readonly.waitForSelector('[data-connection-state="connected"]',{timeout:15000});
 const watched:any=await(await fetch('http://127.0.0.1:8791/state')).json();await readonly.mouse.click(600,550);await readonly.keyboard.type('MUST NOT TYPE');await readonly.waitForTimeout(500);
 const watchedAfter:any=await(await fetch('http://127.0.0.1:8791/state')).json();results.checks.viewOnlyBlocksInput=watchedAfter.clicks===watched.clicks&&watchedAfter.text===watched.text;
 const bad=await browser.newPage();const wrong=new URL(url);wrong.hash='password=invalid!';await bad.goto(wrong.toString());
 await bad.waitForSelector('[data-connection-state="authentication-failed"]',{timeout:15000});results.checks.wrongPasswordRejected=true;await bad.close();
 results.pass=Object.values(results.checks).every(Boolean)&&Object.keys(results.checks).length===9;
 if(!results.pass)process.exitCode=1;
 console.log(JSON.stringify(results,null,2));
}catch(error){const password=new URLSearchParams(url.hash.slice(1)).get('password')??'';const sanitize=(value:string)=>password?value.split(password).join('[redacted]'):value;console.log(JSON.stringify({...results,pass:false,error:sanitize(String(error)),diagnostics:diagnostics.map(sanitize),state:view?await view.locator('#screen').getAttribute('data-connection-state').catch(()=>null):null},null,2));process.exitCode=1}finally{await browser.close()}
