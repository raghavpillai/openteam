import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BrowserUseSession} from '../src/browser/use';
import {outOfProcessPlaywright} from '../src/browser/playwright-driver';

const destination=process.env.SCREENSHOT_TEST_OUTPUT||'/qa-artifacts';
const prefix='card-'+crypto.randomUUID();
const inner='<body style="margin:0"><button aria-label="Frame detail" style="position:relative;width:140px;height:80px;border:0;padding:0;background:cyan"><span data-openteam-private="true" style="position:absolute;left:10px;top:10px;width:25px;height:25px;background:red">private</span>Frame detail</button>';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(`<html><title>Independent element capture</title><body style="margin:0;height:2000px;background:white"><section id="${prefix}" style="position:relative;width:240px;height:160px;background:rgb(0,170,17)"><div data-openteam-private="true" style="position:absolute;left:16px;top:16px;width:30px;height:30px;background:red">private</div><p style="margin:0;position:absolute;top:80px">Regional schedule</p></section><iframe title="Embedded schedule" style="position:absolute;top:250px;left:0;width:200px;height:120px;border:0" srcdoc="${inner.replaceAll('&','&amp;').replaceAll('"','&quot;')}"></iframe><button aria-label="Offscreen detail" style="position:absolute;left:0;top:1600px;width:130px;height:40px;border:0;padding:0" onclick="window.clicked=true">Offscreen detail</button></body></html>`,{headers:{'content-type':'text/html'}})});
const crossOrigin=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(inner,{headers:{'content-type':'text/html'}})});
const driver=await outOfProcessPlaywright();
const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE||'/usr/local/bin/google-chrome',args:['--no-sandbox']});
const records:any[]=[];
try{
 const context=await browser.newContext({viewport:{width:900,height:600}});
 const session=new (BrowserUseSession as any)(browser,context,destination,'/tmp');
 await session.execute('browser_navigate',{url:server.url.href});
 const page=await session.ensurePage();
 await page.locator('iframe').waitFor();
 await page.frames().find((f:any)=>f!==page.mainFrame())!.locator('button').waitFor();
 const capture=async(label:string,args:any,size?:number[],pixel?:number[])=>{
  const start=Date.now();const result=await session.execute('browser_take_screenshot',args);
  const bytes=Buffer.from(result.content.find((c:any)=>c.type==='image').data,'base64');
  const dimensions=[bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
  if(size)assert.deepEqual(dimensions,size);
  if(args.target)assert.equal(result.details.coordinateSpace,'element');
  await writeFile(join(destination,label+'.png'),bytes);
  records.push({label,dimensions,elapsedMs:Date.now()-start,maskedPixel:pixel,coordinateSpace:result.details.coordinateSpace});
 };
 await capture('selector',{target:'#'+prefix,element:'Schedule detail'},[240,160],[20,20]);
 for(const target of ['button,section','#absent',''])await assert.rejects(()=>session.execute('browser_take_screenshot',{target}));
 await assert.rejects(()=>session.execute('browser_take_screenshot',{target:'#'+prefix,fullPage:true}),/fullPage cannot be used/);
 const getRef=async(label:string)=>{
  const result=await session.execute('browser_snapshot',{});const text=result.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
  const line=text.split('\n').find((l:string)=>l.includes(label)&&l.includes('[ref='));assert.ok(line,'ref for '+label);return line.match(/\[ref=(e\d+)\]/)![1];
 };
 await capture('offscreen-ref',{target:await getRef('Offscreen detail')},[130,40]);
 assert.notEqual(await page.evaluate(()=> (window as any).clicked),true);
 await capture('frame-ref',{target:await getRef('Frame detail')},[140,80],[15,15]);
 // Whole-page masking must include private fields inside the child frame too.
 await page.evaluate(()=>window.scrollTo(0,0));
 await capture('full-page',{fullPage:true},[900,2000],[15,265]);
 const stale=await getRef('Offscreen detail');await page.locator('button[aria-label="Offscreen detail"]').evaluate((node:any)=>node.remove());
 await assert.rejects(()=>session.execute('browser_take_screenshot',{target:stale}),/stale|unknown|detached/i);
 await capture('viewport-after-errors',{},[900,600],[20,20]);
 await page.evaluate(()=>{
  const holder=document.createElement('div');holder.setAttribute('data-openteam-private','true');
  holder.innerHTML='<span id="private-descendant" style="display:inline-block;width:80px;height:40px;background:red">private</span>';
  document.body.append(holder);
 });
 await capture('private-ancestor',{target:'#private-descendant'},[80,40],[20,20]);
 await page.evaluate((url:string)=>{
  const frame=document.createElement('iframe');frame.title='Other origin';frame.src=url;
  frame.style.cssText='position:absolute;left:400px;top:0;width:200px;height:120px;border:0';document.body.append(frame);
 },crossOrigin.url.href);
 await page.waitForFunction(()=>document.querySelector('iframe[title="Other origin"]')?.getAttribute('src'));
 const foreign=await page.locator('iframe[title="Other origin"]').elementHandle().then((element:any)=>element.contentFrame());
 await foreign.locator('button').waitFor();
 assert.notEqual(new URL(foreign.url()).origin,new URL(page.url()).origin);
 await capture('cross-origin-full',{fullPage:true},undefined,[415,15]);
 await mkdir(destination,{recursive:true});await writeFile(join(destination,'results.json'),JSON.stringify(records,null,2)+'\n');console.log(JSON.stringify(records));
}finally{await browser.close();await driver.stop();server.stop(true);crossOrigin.stop(true);}
