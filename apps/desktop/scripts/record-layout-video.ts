import { createServer } from "vite";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const root = resolve(process.argv[2] ?? ".");
const out = resolve(process.argv[3]!);
await mkdir(out, { recursive: true });
const server = await createServer({
  root: join(root, "apps/desktop"),
  cacheDir: join(out, "vite-cache"),
  configFile: join(root, "apps/desktop/vite.config.ts"),
  server: { port: 0 },
  plugins: [
    {
      name: "controlled-render-delay",
      configureServer(s) {
        s.middlewares.use((req, res, next) =>
          /\/message-response(?:\/rich)?\.tsx/.test(req.url ?? "") ? setTimeout(next, 1000) : next()
        );
      },
    },
  ],
});
await server.listen();
const runner = join(out, "runner.cjs");
await writeFile(
  runner,
  `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(out, "profile"))});
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:920,height:820,webPreferences:{offscreen:true,backgroundThrottling:false}});win.webContents.setFrameRate(30);
const frames=[];let started=0;
win.webContents.on('paint',(_e,_r,image)=>{if(!started)return;const file=String(frames.length).padStart(5,'0')+'.png';fs.writeFileSync(${JSON.stringify(out)}+'/'+file,image.toPNG());frames.push({file,ms:Date.now()-started})});
await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + "test/browser/layout-video.html")});
await new Promise(r=>setTimeout(r,600));started=Date.now();await win.webContents.executeJavaScript('window.openConversation()');
setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(out, "frames.json"))},JSON.stringify(frames));app.quit()},7000);
});`
);
const require = createRequire(import.meta.url);
const child = Bun.spawn([require("electron"), runner], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  stdout: "inherit",
  stderr: "inherit",
});
try {
  if (await child.exited) throw new Error("Recording failed");
} finally {
  await server.close();
}
