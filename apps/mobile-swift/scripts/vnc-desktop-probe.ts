/** Inert instrumentation page in the disposable live computer. No product routes are mocked. */
import { chromium } from 'playwright-core';
if (process.env.SWIFT_QA_DISPOSABLE_COMPUTER !== '1') throw new Error('Disposable computer required');
const browser = await chromium.launch({executablePath:'/usr/local/bin/google-chrome',headless:false,
  env:{...process.env,DISPLAY:process.env.SWIFT_QA_DISPLAY ?? ':100'},
  args:['--no-sandbox','--disable-dev-shm-usage','--window-size=1280,800']});
const context = await browser.newContext({viewport:null});
const page = await context.newPage();
const content = `<!doctype html><title>Native desktop validation</title><style>
*{box-sizing:border-box}body{margin:0;font:26px system-ui;background:#182c44;color:white}
header{height:68px;background:#234e75;padding:16px;display:flex;justify-content:space-between}
textarea{display:block;width:100%;height:150px;padding:14px;font:26px system-ui;resize:none}
#target{height:1300px;background:repeating-linear-gradient(#244365 0 96px,#305880 96px 192px);padding:24px}
#pulse{background:#03cda0;padding:10px;border-radius:8px;color:#061524}
</style><header>OpenTeam • actual Linux desktop <span id="pulse">Frame 0</span></header>
<textarea id="input" aria-label="Remote input" placeholder="Keyboard and clipboard validation"></textarea>
<div id="target">Touch target — scroll to move the numbered bands</div><script>
window.receipt={clicks:0,rightClicks:0,moves:0,keys:[],events:[]};
for(const type of ['click','contextmenu','pointerdown','pointermove','pointerup','wheel','keydown'])document.addEventListener(type,e=>{
 if(type==='contextmenu')e.preventDefault();if(!e.isTrusted)return;
 if(type==='click')receipt.clicks++;if(type==='contextmenu')receipt.rightClicks++;
 if(type==='pointermove')receipt.moves++;
 if(type==='keydown')receipt.keys.push(e.key);
 receipt.events.push({type,screenX:e.screenX,screenY:e.screenY,buttons:e.buttons,key:e.key,deltaY:e.deltaY,trusted:e.isTrusted,time:Date.now()});receipt.events=receipt.events.slice(-200);
});let tick=0;setInterval(()=>{pulse.textContent='Frame '+ ++tick;pulse.style.background=tick%2?'#03cda0':'#ffbd4c'},500);
</script>`;
await page.setContent(content);
await page.bringToFront();
const cdp = await context.newCDPSession(page);
const {windowId} = await cdp.send('Browser.getWindowForTarget');
await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'fullscreen'}});
await page.locator('#input').focus();
Bun.serve({hostname:'0.0.0.0',port:8791,async fetch(request){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(await page.evaluate(()=>({... (window as any).receipt,text:(document.querySelector('#input') as HTMLTextAreaElement).value,scrollY:window.scrollY,width:innerWidth,height:innerHeight,pulse:document.querySelector('#pulse')?.textContent})));
 if(url.pathname==='/reset'&&request.method==='POST'){
  await page.bringToFront();await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'fullscreen'}});
  await page.locator('#input').fill('');await page.evaluate(()=>{(window as any).receipt={clicks:0,rightClicks:0,moves:0,keys:[],events:[]};scrollTo(0,0)});await page.locator('#input').focus();return Response.json({ok:true});
 }
 if(url.pathname==='/focus'&&request.method==='POST'){await page.locator('#input').focus();return Response.json({ok:true})}
 if(url.pathname==='/desktop'&&request.method==='POST'){await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});return Response.json({ok:true})}
 return new Response(null,{status:404});
}});
console.log('Real desktop instrumentation ready');
