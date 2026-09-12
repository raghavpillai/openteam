import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childProcess from "node:child_process";
import assert from "node:assert/strict";
const [root, output] = process.argv.slice(2);
process.env.OPENTEAM_NODE_BINARY ??= "/opt/homebrew/opt/node@24/bin/node";
const temp=await mkdtemp(join(tmpdir(),"openteam-browser-regression-"));
const children: childProcess.ChildProcess[]=[];
const originalFork=childProcess.fork;
childProcess.fork=((...args:any[])=>{const child=(originalFork as any)(...args);children.push(child);return child;}) as typeof childProcess.fork;
const web=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response(`<!doctype html><html><head><title>Regression fixture</title></head><body><h1>Browser regression fixture</h1><label>Name<input aria-label="Name" id="name"></label><button onclick="document.getElementById('result').textContent='Submitted: '+document.getElementById('name').value">Submit</button><p id="result">Waiting</p></body></html>`,{headers:{"content-type":"text/html"}})});
const chrome=Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","--headless=new","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${temp}/profile`,"about:blank"],{stdout:"ignore",stderr:"ignore"});
let session:any,second:any;
const checks:string[]=[];
const text=(result:any)=>result.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n");
try {
  let port:string|undefined;
  for(let i=0;i<100;i++){
    try{port=(await readFile(join(temp,"profile/DevToolsActivePort"),"utf8")).split("\n")[0];break;}catch{await Bun.sleep(100);}
  }
  assert.ok(port,"Chrome did not expose a debugging endpoint");
  const {BrowserUseSession}=await import(join(root!,"apps/computer/src/browser/use.ts"));
  session=await BrowserUseSession.connect(`http://127.0.0.1:${port}`,join(temp,"artifacts"));
  await session.execute("browser_navigate",{url:`http://127.0.0.1:${web.port}/`});
  checks.push("real Chromium navigation");
  const initial=text(await session.execute("browser_snapshot",{}));
  assert.ok(initial.includes("Browser regression fixture"));
  const input=initial.match(/\[ref=(e\d+)\][^\n]*"Name"/)?.[1];
  const submit=initial.match(/\[ref=(e\d+)\][^\n]*"Submit"/)?.[1];
  assert.ok(input);assert.ok(submit);checks.push("ARIA snapshot and element references");
  await session.execute("browser_fill",{ref:input,value:"Verified"});
  await session.execute("browser_click",{ref:submit});
  const final=text(await session.execute("browser_snapshot",{}));
  assert.ok(final.includes("Submitted: Verified"));checks.push("form input and click update the real DOM");
  const cdp=text(await session.execute("browser_cdp",{method:"Runtime.evaluate",params:{expression:"document.querySelector('#result').textContent",returnByValue:true}}));
  assert.ok(cdp.includes("Submitted: Verified"));checks.push("page-scoped CDP");
  await assert.rejects(session.execute("browser_cdp",{method:"Browser.close"}),/not allowed/);checks.push("privileged CDP remains blocked");
  const screenshot=await session.execute("browser_take_screenshot",{});
  assert.ok(screenshot.content.some((part:any)=>part.type==="image"));checks.push("PNG screenshot captured");
  second=await BrowserUseSession.connect(`http://127.0.0.1:${port}`,join(temp,"second-artifacts"));
  const tabs=text(await second.execute("browser_tabs",{action:"list"}));
  assert.ok(!tabs.includes("Regression fixture"));checks.push("concurrent sessions have isolated tab ownership");
  await Bun.write(output!,JSON.stringify({checks,passed:checks.length,engine:"Google Chrome headless, isolated profile",externalSites:false},null,2));
  console.log(JSON.stringify({passed:checks.length,checks}));
} finally {
  // BrowserUseSession is disposed by terminating its owned Chromium/driver processes.
  for(const child of children)child.kill("SIGTERM");
  chrome.kill("SIGTERM");await chrome.exited;web.stop();
  childProcess.fork=originalFork;
  await rm(temp,{recursive:true,force:true});
}
