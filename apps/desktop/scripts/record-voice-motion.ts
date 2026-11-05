import { createRequire } from "node:module";
import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "vite";

const root = resolve(import.meta.dir, "../../..");
const output = resolve(process.argv[2] ?? join(root, "output/voice-motion/before"));
const audioInput = process.argv[3];
if (!audioInput)
  throw Error(
    "Usage: bun apps/desktop/scripts/record-voice-motion.ts <output-dir> <speech.wav> [--verify]"
  );
await mkdir(output, { recursive: true });
const wav = join(root, "apps/desktop/test/browser/voice-motion.wav");
await copyFile(resolve(audioInput), wav);
const server = await createServer({
  root: join(root, "apps/desktop"),
  configFile: join(root, "apps/desktop/vite.config.ts"),
  cacheDir: join(output, "vite-cache"),
  server: { port: 0, strictPort: false },
});
await server.listen();
const runner = join(output, "runner.cjs");
await writeFile(
  runner,
  `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(output, "profile"))});
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:600,webPreferences:{offscreen:true,backgroundThrottling:false}});
 win.webContents.setFrameRate(30);let start=0;const frames=[];
 win.webContents.on('paint',(_e,_r,image)=>{if(!start)return;const file=String(frames.length).padStart(5,'0')+'.jpg';fs.writeFileSync(${JSON.stringify(output)}+'/'+file,image.toJPEG(95));frames.push({file,ms:Date.now()-start});});
 win.webContents.on('console-message',e=>{if(e.level==='error')console.error(e.message)});
 await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + "test/browser/voice-motion.html")});
 for(let i=0;i<200;i++){if(await win.webContents.executeJavaScript('typeof window.runVoiceMotion === "function"'))break;await new Promise(r=>setTimeout(r,100));}
 await win.webContents.executeJavaScript('window.warmVoiceMotion()',true);
 start=Date.now();win.webContents.invalidate();
 const result=await win.webContents.executeJavaScript('window.runVoiceMotion()',true);
 fs.writeFileSync(${JSON.stringify(join(output, "frames.json"))},JSON.stringify(frames));
 fs.writeFileSync(${JSON.stringify(join(output, "result.json"))},JSON.stringify({...result,durationMs:Date.now()-start,frames:frames.length}));
 start=0;
 if(${process.argv.includes("--verify")}){
   const layouts=[];
   for(const [theme,width] of [['dark',1440],['light',1440],['dark',860],['light',640]]){
     win.setSize(width,600);
     layouts.push(await win.webContents.executeJavaScript('window.verifyVoiceMotion('+JSON.stringify(theme)+',false)',true));
   }
   win.webContents.debugger.attach('1.3');
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   layouts.push(await win.webContents.executeJavaScript('window.verifyVoiceMotion("dark",true)',true));
   fs.writeFileSync(${JSON.stringify(join(output, "verification.json"))},JSON.stringify(layouts,null,2));
   console.log(JSON.stringify(layouts));
 }
 app.quit();
}).catch(e=>{console.error(e);app.exit(1)});`
);
try {
  const electron = createRequire(import.meta.url)("electron") as string;
  const child = Bun.spawn([electron, runner], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdout: "inherit",
    stderr: "inherit",
  });
  const timer = setTimeout(() => child.kill(), 60000);
  const code = await child.exited;
  clearTimeout(timer);
  if (code) throw Error(`Recording exited ${code}`);
  const frames: { file: string; ms: number }[] = JSON.parse(
    await readFile(join(output, "frames.json"), "utf8")
  );
  const concat = frames.flatMap((frame, i) => [
    `file '${frame.file}'`,
    `duration ${Math.max(0.001, ((frames[i + 1]?.ms ?? frame.ms + 34) - frame.ms) / 1000)}`,
  ]);
  concat.push(`file '${frames.at(-1)!.file}'`);
  await writeFile(join(output, "frames.ffconcat"), `${concat.join("\n")}\n`);
  const encode = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      join(output, "frames.ffconcat"),
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      join(output, "voice-motion.mp4"),
    ],
    { stdout: "inherit", stderr: "inherit" }
  );
  if (await encode.exited) throw Error("MP4 encoding failed");
  console.log(join(output, "voice-motion.mp4"));
} finally {
  await server.close();
  await rm(wav, { force: true });
}
