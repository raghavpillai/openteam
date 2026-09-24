import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AssetStore } from "../src/asset-store";
import { AgentDataStore } from "../src/agent-data";

// A subprocess is essential: a promise rejection alone misses fatal unhandled
// ReadStream errors, even when Bun also executes the surrounding catch.
(process.getuid?.() === 0 ? test.skip : test)("unreadable attachment is caught without killing the process; later deliveries succeed", async () => {
  const root = await mkdtemp(join(tmpdir(), "access-denied-"));
  try {
    await writeFile(join(root, "denied.txt"), "harmless");
    await chmod(join(root, "denied.txt"), 0);
    await writeFile(join(root, "ok.txt"), "readable");
    const script = `
      import { AssetStore } from ${JSON.stringify(new URL("../src/asset-store.ts", import.meta.url).pathname)};
      const store = new AssetStore({root:${JSON.stringify(join(root, "assets"))},allowedFileRoots:[${JSON.stringify(root)}]});
      for(let attempt=0;attempt<3;attempt++) {
        try { await store.ingestSource({url:${JSON.stringify(pathToFileURL(join(root, "denied.txt")).href)}}); throw new Error("unexpected success"); }
        catch(e) { if(e.code!=="asset_file_unreadable") throw e; }
        const result=await store.ingestSource({url:${JSON.stringify(pathToFileURL(join(root, "ok.txt")).href)}});
        if(result.byteSize!==8) throw new Error("subsequent delivery failed");
      }
      console.log("RECOVERED_THREE_TIMES");
    `;
    await writeFile(join(root, "probe.ts"), script);
    const child = Bun.spawn([process.execPath, join(root, "probe.ts")], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, err}).toEqual({code:0, err:""});
    expect(out).toContain("RECOVERED_THREE_TIMES");
    expect((await readdir(join(root, "assets"))).filter(x => x.endsWith(".tmp"))).toEqual([]);
  } finally { await rm(root, {recursive:true,force:true}); }
});

test("delivery allows ordinary nested files and denies actual private state including symlinks", async () => {
  const root=await mkdtemp(join(tmpdir(),"access-policy-"));
  const state=join(root,"state");
  const store=new AssetStore({root:join(root,"assets"),allowedFileRoots:[root],agentDataRoot:state});
  try {
    for(const relative of ["accessqa/public.txt","agents/bot/accessqa/store.db","agents/bot/store.db","agents/bot/store.db-wal","settings.json","transcription.json","connector-secrets/test.json",".openteam/marker.json"]) {
      const path=join(state,relative);await mkdir(join(path,".."),{recursive:true});await writeFile(path,"harmless test fixture");
      if(relative.startsWith("accessqa/")||relative.includes("/accessqa/")) expect((await store.ingestSource({url:pathToFileURL(path).href})).byteSize).toBeGreaterThan(0);
      else await expect(store.ingestSource({url:pathToFileURL(path).href})).rejects.toMatchObject({code:"asset_path_protected"});
    }
    const alias=join(root,"innocent.txt");await symlink(join(state,"settings.json"),alias);
    await expect(store.ingestSource({url:pathToFileURL(alias).href})).rejects.toMatchObject({code:"asset_path_protected"});
  } finally {await rm(root,{recursive:true,force:true});}
});

test("bot creation, repair, and server edits retain shared configuration permissions", async () => {
  const root=await mkdtemp(join(tmpdir(),"access-profile-"));
  const bot={id:"fixture",name:"Before",status:"active",avatarPath:null};
  const tx={$executeRaw:async()=>0,bot:{findUnique:async()=>bot}};
  const store=new AgentDataStore({$transaction:async(fn:any)=>fn(tx)} as never,{root,workspaceRoot:root});
  const mode=async(name:string)=>(await stat(join(root,name))).mode&0o777;
  try {
    await store.ensureRuntimeDirectories();await store.initializeBot(bot.id);
    expect(await mode("agents/fixture/profile.json")).toBe(0o664);
    expect(await mode("agents/fixture/settings.json")).toBe(0o664);
    await chmod(join(root,"agents/fixture/profile.json"),0o644);
    await store.initializeBot(bot.id);
    expect(await mode("agents/fixture/profile.json")).toBe(0o664);
    bot.name="After";await store.writeBotFiles(bot.id,["profile","settings"]);
    expect(JSON.parse(await readFile(join(root,"agents/fixture/profile.json"),"utf8")).name).toBe("After");
    expect(await mode("agents/fixture/profile.json")).toBe(0o664);
    expect(await mode("agents/fixture/settings.json")).toBe(0o664);
    expect(await mode("settings.json")).toBe(0o600);
    expect(await mode("connector-secrets")).toBe(0o700);
    await rm(join(root,"agents/fixture/profile.json"));
    await symlink(join(root,"settings.json"),join(root,"agents/fixture/profile.json"));
    await expect(store.initializeBot(bot.id)).rejects.toThrow();
    expect(await mode("settings.json")).toBe(0o600);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("installed managed catalog is discoverable without including disabled or missing skills", async () => {
  const root=await mkdtemp(join(tmpdir(),"access-catalog-"));
  const store=new AgentDataStore({} as never,{root,workspaceRoot:root});
  try {
    await store.ensureRuntimeDirectories();
    const rendered=await (store as any).renderManagedSkills();
    expect(rendered).toContain("managed:routines");
    expect(rendered).toContain(join(root,"managed-skills/routines/SKILL.md"));
    await rm(join(root,"managed-skills/routines/SKILL.md"));
    expect(await (store as any).renderManagedSkills()).not.toContain("managed:routines");
    await chmod(join(root,"managed-skills/cache.json"),0o644);
    await writeFile(join(root,"managed-skills/cache.json"),'{"version":"disabled","skills":[]}');
    expect(await (store as any).renderManagedSkills()).toBe("");
  } finally {await rm(root,{recursive:true,force:true});}
});
