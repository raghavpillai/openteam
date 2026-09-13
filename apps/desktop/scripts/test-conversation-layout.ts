import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

// Real Chromium geometry and frame scheduling, using synthetic messages only.
// Run separately from DOM-independent unit tests; requires the Electron runtime.
const require = createRequire(import.meta.url);
const electron = require("electron") as string;
const directory = await mkdtemp(join(tmpdir(), "openteam-conversation-layout-"));
const mode = process.argv.includes("--development") ? "development" : "production";
try {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../test/browser/conversation-layout.tsx")],
    outdir: directory,
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": JSON.stringify(mode) },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  // Only positioning/layout CSS is needed. The components and hooks themselves
  // are the shipping sources, including the scroll container and virtual rows.
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0}
    [role=log]{position:relative;overflow:hidden}
    [role=log]>div{overflow-y:auto}
    [role=log]>div>div{padding:40px 16px 24px;display:flex;flex-direction:column}
    [data-virtual-timeline-count]{position:relative;width:100%}
    [data-virtual-timeline-index]{position:absolute;top:0;left:0;right:0;display:flex;flex-direction:column;padding-bottom:4px}
    .sr-only{position:absolute;width:1px;height:1px;overflow:hidden}
    </style></head><body><div id="root"></div><script type="module" src="conversation-layout.js"></script></body></html>`
  );
  await writeFile(
    join(directory, "main.cjs"),
    `
    const {app,BrowserWindow}=require('electron');
    const fs=require('node:fs'); const path=require('node:path');
    app.setPath('userData',path.join(__dirname,'profile'));
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1100,height:1500,webPreferences:{backgroundThrottling:false}});
      win.webContents.on('console-message',event=>{
        if(event.level==='error'||event.level===3)console.error(event.message);
      });
      await win.loadFile(path.join(__dirname,'index.html'));
      for(let attempt=0;attempt<200;attempt++){
        await new Promise(resolve=>setTimeout(resolve,100));
        const result=await win.webContents.executeJavaScript('window.layoutResults');
        if(result){fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify(result));app.quit();return;}
      }
      fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify({error:'Browser test timed out'}));
      app.quit();
    }).catch(error=>{console.error(error);app.exit(1);});
  `
  );
  const child = Bun.spawn([electron, join(directory, "main.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 25_000);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`Electron exited ${code}: ${stdout}\n${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  for (const report of result.reports ?? [])
    console.log(`PASS ${report.name} (${report.rowMounts} row mounts)`);
  if (result.error) throw new Error(`${result.error}\n${result.stack ?? ""}\n${stderr}`);
  console.log(`${result.reports.length} conversation layout scenarios passed.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
