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
test("ordinary browser connection retains page creation",async()=>{
 const folder=await mkdtemp(join(tmpdir(),"active-connect-"));
 const driverSpy=replaceDriver();
 try{
  creations=0;
  await expect(BrowserUseSession.connect("http://127.0.0.1:9341",folder,true,folder)).rejects.toThrow("page creation requested");
  expect(creations).toBe(1);
 }finally{driverSpy.mockRestore();await rm(folder,{recursive:true,force:true});}
});
