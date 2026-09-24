import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NativeToolExecutor } from "../src/native-tool-executor";
import { boundToolImage, repairImageHistory } from "../src/runtime/image-input";
import { stageAttachment } from "../src/attachment-staging";
import { RuntimeTools } from "../src/runtime/tools";

test("binary reads fail locally and a later text read succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "edge-read-"));
  try {
    const ex = new NativeToolExecutor({ agentDir: root, controlToken: "fixture" });
    for (const [name, bytes] of [["document.docx", Buffer.from([80,75,3,4,0,65])], ["nul.txt", Buffer.from([65,0,66])], ["invalid.txt", Buffer.from([255,254,253])]] as const) {
      await writeFile(join(root,name), bytes);
      await expect(ex.read({path:join(root,name)},root)).rejects.toThrow("Binary files");
    }
    await writeFile(join(root,"ok.txt"),"café 日本語");
    expect(JSON.stringify(await ex.read({path:join(root,"ok.txt")},root))).toContain("café 日本語");
    for(const [name,bytes] of [["utf16.txt",Buffer.concat([Buffer.from([255,254]),Buffer.from("café 日本語","utf16le")])],["latin1.txt",Buffer.from("café","latin1")],["fake.png",Buffer.from("plain text")]] as const) {
      await writeFile(join(root,name),bytes);
      expect(JSON.stringify(await ex.read({path:join(root,name)},root))).toContain(name==="fake.png"?"plain text":"café");
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("malformed images become notices, including old history, without mutating receipts", async () => {
  const data="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0N8AAAAASUVORK5CYII=";
  expect(await boundToolImage(Buffer.from(data,"base64"),"image/png")).toMatchObject({type:"text"});
  const receipt={role:"toolResult",content:[{type:"image",data,mimeType:"image/png"},{type:"text",text:"Keep this receipt"}]};
  const repaired=await repairImageHistory([receipt]);
  expect(repaired[0]!.content[0]).toMatchObject({type:"text"});
  expect(repaired[0]!.content[1]).toEqual(receipt.content[1]);
  expect(receipt.content[0]!.type).toBe("image");
  expect((await repairImageHistory([receipt]))[0]).toBe(repaired[0]);
});

test("shell restores scoped cwd/env after errors, honors overrides and recovers from deleted cwd", async () => {
  const root=await mkdtemp(join(tmpdir(),"edge-shell-"));
  try {
    await mkdir(join(root,"sub"));
    const ex=new NativeToolExecutor({agentDir:root,controlToken:"fixture"});
    const run=(command:string,working_directory?:string,scope="a")=>ex.shell({command,working_directory},root,undefined,undefined,scope);
    await run(`cd '${root}/sub' && export EDGE_VALUE=kept && (exit 7)`);
    expect(await ex.shellWorkingDirectory({},root,"a")).toBe(join(root,"sub"));
    expect(JSON.stringify(await run('pwd; printf "%s" "$EDGE_VALUE"'))).toContain(`${root}/sub\\nkept`);
    expect(await ex.shellWorkingDirectory({},root,"b")).toBe(root);
    await run("pwd",root);
    expect(await ex.shellWorkingDirectory({},root,"a")).toBe(root);
    await run(`cd '${root}/sub'`);
    await rm(join(root,"sub"),{recursive:true});
    expect(await ex.shellWorkingDirectory({},root,"a")).toBe(root);
    expect((await run("printf recovered")).details.exitCode).toBe(0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("staging ordinary and empty deliverables preserves names and denies hidden/symlink targets", async () => {
  const root=await mkdtemp(join(tmpdir(),"edge-stage-"));
  try {
    const options={workspace:join(root,"workspace"),agentData:join(root,"state"),home:join(root,"home"),temporary:join(root,"tmp")};
    for(const dir of Object.values(options)) await mkdir(dir);
    for(const name of ["résumé 日本語 #1.txt","empty.txt"]) {
      const source=join(options.home,name);await writeFile(source,name==="empty.txt"?"":"canary");
      const staged=await stageAttachment(pathToFileURL(source).href,options);
      expect(await readFile(fileURLToPath(staged.url),"utf8")).toBe(name==="empty.txt"?"":"canary");
      expect(fileURLToPath(staged.url)).toEndWith(name);
      await staged.cleanup();
    }
    await mkdir(join(options.home,".private"));await writeFile(join(options.home,".private","secret"),"fixture");
    const alias=join(options.home,"innocent.txt");await symlink(join(options.home,".private","secret"),alias);
    await expect(stageAttachment(pathToFileURL(alias).href,options)).rejects.toThrow("ordinary box deliverable");
    expect(await readdir(options.workspace)).toEqual([]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("review keeps omitted directory arguments and receives the effective persisted target", async()=>{
  const root=await mkdtemp(join(tmpdir(),"edge-review-"));
  const server=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>Response.json({environment:{}})});
  try {
    await mkdir(join(root,"sub"));
    const runtime=new RuntimeTools({} as never,server.url.origin,"fixture",root,root) as any;
    const native=runtime.nativeToolExecutor as NativeToolExecutor;
    const reviews:any[]=[];
    native.autoReviewAction=async(input:any)=>{reviews.push(input)};
    const active={runtimeProfile:"agent",botId:"edge-review",runId:"run",cwd:root,queue:{push:()=>{}},pendingReviewIds:new Set()} as any;
    await runtime.executeScopedTool(active,"one","Shell",{command:`cd '${root}/sub'`});
    await runtime.executeScopedTool(active,"two","Shell",{command:"pwd"});
    expect(reviews[1].arguments).toEqual({command:"pwd"});
    expect(reviews[1].target).toBe(join(root,"sub"));
  } finally {server.stop(true);await rm(root,{recursive:true,force:true});}
});
