import {expect, test, spyOn} from "bun:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as driverModule from "../../src/browser/playwright-driver";
import {BrowserUseSession} from "../../src/browser/use";
let creations=0;
const context={on:()=>{},pages:()=>[],newPage:async()=>{creations++;throw new Error("page creation requested");}};
const cdp={on:()=>{},send:async()=>({})};
const browser={contexts:()=>[context],newBrowserCDPSession:async()=>cdp,on:()=>{},isConnected:()=>true};
const replaceDriver=()=>spyOn(driverModule,"outOfProcessPlaywright").mockResolvedValue({playwright:{chromium:{connectOverCDP:async()=>browser}}} as any);
test("passive attachment creates no tab in shared or isolated browser",async()=>{
 const folder=await mkdtemp(join(tmpdir(),"passive-connect-"));
 const driverSpy=replaceDriver();
 try{
  creations=0;
  const session=await BrowserUseSession.connect("http://127.0.0.1:9341",folder,true,folder,undefined,false);
  expect(session.connected).toBe(true);
  expect(creations).toBe(0);
  expect(await session.focusedLoginSite()).toBeNull();
  await BrowserUseSession.connect("http://127.0.0.1:9341",folder,false,folder,undefined,false);
  expect(creations).toBe(0);
 }finally{driverSpy.mockRestore();await rm(folder,{recursive:true,force:true});}
});
test("ordinary browser connection retains page creation",async()=>{
 const folder=await mkdtemp(join(tmpdir(),"active-connect-"));
 const driverSpy=replaceDriver();
 try{
  creations=0;
  await expect(BrowserUseSession.connect("http://127.0.0.1:9341",folder,true,folder)).rejects.toThrow("page creation requested");
  expect(creations).toBe(1);
 }finally{driverSpy.mockRestore();await rm(folder,{recursive:true,force:true});}
});
