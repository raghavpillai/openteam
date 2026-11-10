import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "openteam-activity-history-"));
const output = resolve(import.meta.dir, "../../../output/activity-history");
await mkdir(output, { recursive: true });
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
        if (event.level === 'error') console.error(event.message);
      });
      const results = [];
      try {
        for (const query of ['runs', 'channelRounds', 'subagents', 'runItems&active=1', 'runs&thread=1']) {
          const result = new Promise(resolve => {
            const listener = event => {
              if (event.message.startsWith('ACTIVITY_HISTORY_RESULT ')) {
                win.webContents.removeListener('console-message', listener);
                resolve(JSON.parse(event.message.slice('ACTIVITY_HISTORY_RESULT '.length)));
              }
            };
            win.webContents.on('console-message', listener);
          });
          await win.loadURL(${JSON.stringify(`${server.resolvedUrls!.local[0]}test/browser/activity-history.html?truncated=`)} + query);
          const report = await result;
          results.push(report);
          if (query === 'runs') fs.writeFileSync(${JSON.stringify(join(output, process.argv.includes("--repro") ? "before.png" : "after.png"))}, (await win.webContents.capturePage()).toPNG());
        }
        fs.writeFileSync(${JSON.stringify(join(directory, "results.json"))}, JSON.stringify(results));
      } catch (error) { console.error(error); process.exitCode = 1; }
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
  if (code) throw new Error(`Electron failed: ${stderr}`);
  const results = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  console.log(JSON.stringify(results, null, 2));
  for (const result of results) {
    if (
      !result.stateReads ||
      !result.messagesVisible ||
      result.banner !== process.argv.includes("--repro") ||
      result.thinkingVisible !== result.active ||
      result.threadNotice !== result.thread
    ) {
      throw new Error(`Activity history regression: ${JSON.stringify(result)}`);
    }
  }
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
