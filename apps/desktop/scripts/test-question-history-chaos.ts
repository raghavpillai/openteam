import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-question-history-"));
const server = await createServer({
  root: resolve(import.meta.dir, ".."),
  configFile: resolve(import.meta.dir, "../vite.config.ts"),
  server: { port: 0, strictPort: false },
});
try {
  await server.listen();
  const runner = join(directory, "runner.cjs");
  await writeFile(
    runner,
    `
    const {app, BrowserWindow} = require('electron');
    const fs = require('node:fs');
    app.setPath('userData', ${JSON.stringify(join(directory, "profile"))});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({show:false, width:1200, height:800,
        webPreferences:{backgroundThrottling:false}});
      win.webContents.on('console-message', event => {
        console.error(event.message);
      });
      const results = [];
      try {
        for (const query of ['', 'answered=1']) {
          const result = new Promise(resolve => {
            const listener = event => {
              if (event.message.startsWith('QUESTION_HISTORY_RESULT ')) {
                win.webContents.removeListener('console-message', listener);
                resolve(JSON.parse(event.message.slice('QUESTION_HISTORY_RESULT '.length)));
              }
            };
            win.webContents.on('console-message', listener);
          });
          await win.loadURL(${JSON.stringify(`${server.resolvedUrls!.local[0]}test/browser/question-history-chaos.html?`)} + query);
          const report = await result;
          if (report.error) throw new Error(report.error);
          results.push(report);
        }
        fs.writeFileSync(${JSON.stringify(join(directory, "results.json"))}, JSON.stringify(results));
      } catch (error) { console.error(error); app.exit(1); return; }
      app.quit();
    });
  `
  );
  const child = Bun.spawn([require("electron") as string, runner], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 60_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Electron failed: ${stderr}`);
  const results = JSON.parse(
    await readFile(join(directory, "results.json"), "utf8").catch((error) => {
      throw new Error(`${error}\n${stderr}`);
    })
  );
  if (
    results.length !== 2 ||
    results.some(
      (result: { restored: boolean; reads: number }) => !result.restored || result.reads < 2
    )
  )
    throw new Error(`Question history regression: ${JSON.stringify(results)}`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
