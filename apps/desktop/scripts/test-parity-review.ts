import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); const electron = require('electron') as string;
const directory = await mkdtemp(join(tmpdir(), 'openteam-parity-review-'));
const artifacts = resolve(import.meta.dir, '../../../findings/grokbot-context-2026-09-12/parity-research/review-ui');
try {
 await mkdir(artifacts, { recursive: true });
 const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../test/browser/parity-review.tsx')], outdir: directory, target: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } });
 if (!build.success) throw new Error(build.logs.join('\n'));
 await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><style>
 *{box-sizing:border-box}body{font-family:system-ui;background:#fafafa;color:#171717;margin:0;padding:32px}h1{font-size:24px;font-weight:550;margin:0 0 24px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}section{min-width:0}.rich-message-card{display:flex;flex-direction:column;gap:14px;background:#eee;border-radius:18px;padding:20px;font-size:14px;line-height:1.45}p{margin:0}label{display:flex;flex-direction:column;gap:5px}input,textarea,select{font:inherit;padding:9px;border:1px solid #d4d4d4;border-radius:8px;min-width:0;background:white;color:inherit}input[type=checkbox]{width:16px;height:16px}button{font:inherit;border:0;background:#202020;color:white;padding:9px 12px;border-radius:8px;cursor:pointer;margin:3px}button:disabled{opacity:.4;cursor:default}strong{font-size:16px}pre{overflow:auto;white-space:pre-wrap;max-height:280px}summary{cursor:pointer}.text-xs{font-size:12px}.text-muted-foreground{color:#606060}.text-red-600{color:#b91c1c}textarea{width:100%}section>div>div:last-of-type{display:flex;flex-wrap:wrap;gap:4px}
 </style></head><body><div id="root"></div><script type="module" src="parity-review.js"></script></body></html>`);
 await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1420,height:1000,webPreferences:{backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));let captured=false;for(let i=0;i<200;i++){await new Promise(r=>setTimeout(r,50));if(!captured&&await win.webContents.executeJavaScript('window.parityReady')){fs.writeFileSync(${JSON.stringify(join(artifacts, 'review-cards.png'))},(await win.webContents.capturePage()).toPNG());captured=true;}const result=await win.webContents.executeJavaScript('window.parityResults');if(result){fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify(result));app.quit();return;}}app.exit(1)}).catch(e=>{console.error(e);app.exit(1)});`);
 const child = Bun.spawn([electron, join(directory, 'main.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdout: 'pipe', stderr: 'pipe' }); const timer = setTimeout(() => child.kill(), 20_000);
 const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]); clearTimeout(timer);
 if (code) throw new Error(`Electron failed: ${stderr}`);
 const result = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8')); if (result.error) throw new Error(result.error + '\n' + result.stack);
 await writeFile(join(artifacts, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await rm(directory, { recursive: true, force: true }); }
