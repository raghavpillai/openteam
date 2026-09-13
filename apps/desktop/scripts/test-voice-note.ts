import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron") as string;
const fixture = process.argv.includes("--microphone") ? "microphone" : "voice-note";
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex === -1 ? null : resolve(process.argv[outputIndex + 1]!);
const referenceIndex = process.argv.indexOf("--reference-dir");
const reference = referenceIndex === -1 ? null : resolve(process.argv[referenceIndex + 1]!);
const directory = await mkdtemp(join(tmpdir(), "openteam-voice-note-browser-"));
try {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, `../test/browser/${fixture}.tsx`)],
    outdir: directory,
    target: "browser",
    format: "esm",
    // Vite normally resolves worker URLs. Thread fixtures never open PDF previews.
    plugins: [
      {
        name: "fixture-worker-urls",
        setup(build) {
          build.onResolve({ filter: /\?url$/ }, (args) => ({
            path: args.path,
            namespace: "fixture-url",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture-url" }, () => ({
            contents: 'export default "";',
            loader: "js",
          }));
        },
      },
    ],
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env.VITE_OPENTEAM_API_URL": '"http://localhost:8787"',
    },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const assets = resolve(import.meta.dir, "../dist/assets");
  const css = (await readdir(assets).catch(() => [])).find((file) => /^index-.*\.css$/.test(file));
  await writeFile(join(directory, "style.css"), css ? await readFile(join(assets, css)) : "");
  if (reference) {
    for (const file of ["grok-recording-chip.js", "grok-recording-chip.css"]) {
      await writeFile(join(directory, file), await readFile(join(reference, file)));
    }
  }
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="style.css">${reference ? '<link rel="stylesheet" href="grok-recording-chip.css"><script src="grok-recording-chip.js"></script>' : ""}</head><body style="padding:32px;max-width:800px"><div id="root"></div><script type="module" src="${fixture}.js"></script></body></html>`
  );
  await writeFile(
    join(directory, "main.cjs"),
    `
    const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
    app.setPath('userData',path.join(__dirname,'profile'));
    app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:850,height:420,webPreferences:{backgroundThrottling:false}});
      win.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)console.error(event.message);});
      await win.loadFile(path.join(__dirname,'index.html'));
      for(let i=0;i<650;i++){
        await new Promise(resolve=>setTimeout(resolve,100));
        const result=await win.webContents.executeJavaScript('window.voiceResults');
        if(result){
          fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify(result));
          if(process.env.QA_SCREENSHOT && !result.error){
            const states=await win.webContents.executeJavaScript('window.voiceScreenshotStates ?? ["microphone"]');
            for(const state of states){
              await win.webContents.executeJavaScript('window.prepareVoiceScreenshot ? window.prepareVoiceScreenshot('+JSON.stringify(state)+') : window.prepareMicrophoneScreenshot?.()',true);
              await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,180))))');
              const bounds=win.getContentBounds();
              fs.writeFileSync(path.join(__dirname,state+'.png'),(await win.webContents.capturePage({x:0,y:0,width:bounds.width,height:bounds.height},{stayHidden:true})).toPNG());
              await win.webContents.executeJavaScript('window.finishVoiceScreenshot?.();window.finishMicrophoneScreenshot?.()');
            }
            const comparison=await win.webContents.executeJavaScript('window.voiceVisualComparison');
            if(comparison)fs.writeFileSync(path.join(__dirname,'comparison.json'),JSON.stringify(comparison,null,2));
          }
          app.quit();return;
        }
      }app.exit(1);
    }).catch(error=>{console.error(error);app.exit(1);});
  `
  );
  const child = Bun.spawn([electron, join(directory, "main.cjs")], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      QA_SCREENSHOT: output ? "1" : undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 75_000);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`Browser test exited ${code}: ${stdout}\n${stderr}`);
  const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  if (result.error) throw new Error(`${result.error}\n${result.stack}\n${stderr}`);
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2));
    for (const file of await readdir(directory)) {
      if (file.endsWith(".png") || file === "comparison.json") {
        await writeFile(join(output, file), await readFile(join(directory, file)));
      }
    }
  }
  for (const report of result.reports) console.log(`PASS ${report}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
