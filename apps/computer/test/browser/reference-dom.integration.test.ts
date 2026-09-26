import {test,expect} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BrowserUseSession} from "../../src/browser/use";
import {outOfProcessPlaywright} from "../../src/browser/playwright-driver";

test.skipIf(!process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE)("reference snapshots and fills handle shadow DOM, cross-origin frames, controlled inputs, OTP and remaps",async()=>{
 const root=await mkdtemp(join(tmpdir(),"reference-dom-"));
 const child=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response('<label>Frame field <input></label>',{headers:{"content-type":"text/html"}})});
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response(`<!doctype html><title>DOM fixture</title><h1>Visible heading</h1><fixture-login id="shadow" style="display:block"></fixture-login><label>Masked number <input id="masked"></label><label>Replaceable <input id="replaceable"></label><form id="otp">${Array.from({length:6},(_,i)=>`<input aria-label="Code ${i+1}" maxlength="1" inputmode="numeric" style="width:25px">`).join('')}</form><iframe src="http://localhost:${child.port}/"></iframe><script>
 shadow.attachShadow({mode:'closed'}).innerHTML='<label>Shadow field <input></label>';
 masked.addEventListener('input',e=>{if(!e.isTrusted)masked.value='';});
 for(const input of otp.querySelectorAll('input'))input.addEventListener('input',()=>{if(input.value.length===1)input.nextElementSibling?.focus()});
 </script>`,{headers:{"content-type":"text/html"}})});
 const driver=await outOfProcessPlaywright();const browser=await driver.playwright.chromium.launch({headless:true,executablePath:process.env.OPENTEAM_BROWSER_TEST_EXECUTABLE});const context=await browser.newContext();const session=new (BrowserUseSession as any)(browser,context,root) as BrowserUseSession;
 const text=(result:any):string=>result.content.filter((item:any)=>item.type==="text").map((item:any)=>item.text).join('\n');
 try {
  await session.execute("browser_navigate",{url:server.url.origin});
  let snapshot=text(await session.execute("browser_snapshot",{}));
  expect(snapshot).toContain("Visible heading");expect(snapshot).toContain("Shadow field");expect(snapshot).toContain("Frame field");expect(snapshot).toContain("[gen=");
  const ref=(label:string)=>snapshot.split('\n').find(line=>line.includes('[ref=')&&line.includes(label))!.match(/\[ref=(e\d+)\]/)![1]!;
  snapshot=text(await session.execute("browser_fill",{ref:ref("Shadow field"),element:"Shadow field",value:"shadow fixture"}));
  snapshot=text(await session.execute("browser_fill",{ref:ref("Frame field"),element:"Frame field",value:"frame fixture"}));
  snapshot=text(await session.execute("browser_fill",{ref:ref("Masked number"),element:"Masked number",value:"12345"}));
  const page=await (session as any).ensurePage();expect(await page.locator('#masked').inputValue()).toBe("12345");
  const binding=(await session.formPages("127.0.0.1"))[0]!;
  const previous=ref("Replaceable");await page.locator('#replaceable').evaluate((node:HTMLElement)=>node.replaceWith(node.cloneNode(true)));
  expect(await session.fillForm(binding,{id:"replacement",label:"Replaceable",type:"text",target:{kind:"ref",value:previous}},"private replacement")).toBe(true);
  expect(await page.locator('#replaceable').inputValue()).toBe("private replacement");
  await session.fillForm(binding,{id:"code",label:"Code",type:"otp",target:{kind:"selector",value:'#otp input:first-child'}} as any,"731942");
  expect(await page.locator('#otp input').evaluateAll((nodes:HTMLInputElement[])=>nodes.map(node=>node.value).join(''))).toBe("731942");
  snapshot=text(await session.execute("browser_snapshot",{}));expect(snapshot).not.toContain("731942");expect(snapshot).not.toContain("private replacement");
  await expect(session.execute("browser_cdp",{method:"Runtime.evaluate",params:{expression:'btoa(document.querySelector("#replaceable").value)',returnByValue:true}})).rejects.toThrow("private login data");
  await page.locator('#replaceable').evaluate((node:HTMLElement)=>node.style.display='none');
  expect(await session.prepareForm(binding,{title:"Hidden",instruction:"Fixture",domain:"127.0.0.1",fields:[{id:"hidden",label:"Replaceable",type:"text",target:{kind:"selector",value:'#replaceable'}}]})).toMatchObject({reachable:[],failureKinds:{hidden:"hidden_target"}});
  await expect(session.fillForm(binding,{id:"hidden",label:"Replaceable",type:"text",target:{kind:"selector",value:'#replaceable'}},"never written")).rejects.toThrow("hidden");
  await page.evaluate(()=>history.pushState({},'', '/next'));
  await expect(session.fillForm(binding,{id:"moved",label:"Masked number",type:"text",target:{kind:"selector",value:'#masked'}},"never written")).rejects.toThrow("moved");
 }finally{await browser.close();await driver.stop();server.stop(true);child.stop(true);await rm(root,{recursive:true,force:true});}
},60_000);
