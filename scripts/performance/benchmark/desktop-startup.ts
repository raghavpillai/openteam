import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Cold Electron processes and Chromium profiles, warm OS/filesystem/server caches.
// This launches only the supplied audit app; it does not drive or mutate the UI.
const root = resolve(process.env.OPENTEAM_STARTUP_AUDIT_ROOT ?? "");
if (!process.env.OPENTEAM_STARTUP_AUDIT_ROOT)
  throw new Error("OPENTEAM_STARTUP_AUDIT_ROOT is required");
const electron = resolve(import.meta.dir, "../../../apps/desktop/node_modules/.bin/electron");
const results: unknown[] = [];
const runTag = Date.now().toString(36);
const order = ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"];
for (let index = 0; index < order.length; index += 1) {
  const arm = order[index]!;
  const app = resolve(root, arm, "electron-app");
  await mkdir(app, { recursive: true });
  await writeFile(
    resolve(app, "package.json"),
    JSON.stringify({
      name: `openteam-perf-${arm}`,
      version: "0.0.1",
      main: "../dist-electron/main.js",
      type: "module",
    })
  );
  const port = 9340 + index;
  const started = performance.now();
  const processHandle = Bun.spawn(
    [
      electron,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${resolve(root, arm, `startup-profile-${runTag}-${index}`)}`,
      app,
    ],
    {
      env: {
        ...process.env,
        OPENTEAM_RENDERER_URL: `http://127.0.0.1:${arm === "baseline" ? 5175 : 5176}/?scenario=startup-${arm}-${index}`,
        OPENTEAM_HOST_BRIDGE_PORT: String(8950 + index),
      },
      stdout: "ignore",
      stderr: "ignore",
    }
  );
  let socket: WebSocket | null = null;
  try {
    let target: { webSocketDebuggerUrl?: string } | undefined;
    while (performance.now() - started < 20_000) {
      try {
        target = (
          (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
            type: string;
            webSocketDebuggerUrl?: string;
          }>
        ).find((item) => item.type === "page");
      } catch {}
      if (target?.webSocketDebuggerUrl) break;
      await Bun.sleep(50);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error("Startup target did not appear");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map<number, (value: any) => void>();
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(String(event.data));
      const waiter = pending.get(value.id);
      if (waiter) {
        pending.delete(value.id);
        waiter(value);
      }
    });
    const command = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        socket!.send(JSON.stringify({ id, method, params }));
      });
    let capture: any = null;
    while (performance.now() - started < 25_000) {
      const response = await command("Runtime.evaluate", {
        expression: `(() => { const entries=window.openteamPerformance?.snapshot()??[]; const paints=performance.getEntriesByType('paint').map(e=>e.toJSON()); return {ready:paints.some(e=>e.name==='first-contentful-paint')&&entries.some(e=>e.name==='history.page.merge')&&document.querySelectorAll('.message-row').length>0,now:performance.now(),paints,entries}; })()`,
        returnByValue: true,
      });
      capture = response.result?.result?.value;
      if (capture?.ready) break;
      await Bun.sleep(50);
    }
    if (!capture?.ready) throw new Error("Chat DOM never became ready");
    const processToChatDomMs = performance.now() - started;
    await command("HeapProfiler.enable");
    await command("HeapProfiler.collectGarbage");
    const heap = await command("Runtime.getHeapUsage");
    results.push({
      arm,
      run: index,
      processToChatDomMs,
      navigationToChatDomMs: capture.now,
      fcpMs: capture.paints.find((entry: any) => entry.name === "first-contentful-paint")
        ?.startTime,
      heapAfterGc: heap.result,
      entries: capture.entries,
    });
    console.log(
      `${arm} run ${index}: FCP ${capture.paints.find((entry: any) => entry.name === "first-contentful-paint")?.startTime} ms, process-to-chat DOM ${processToChatDomMs.toFixed(1)} ms`
    );
  } finally {
    socket?.close();
    processHandle.kill("SIGTERM");
    await Promise.race([processHandle.exited, Bun.sleep(3000)]);
  }
}
await writeFile(
  resolve(root, "results/desktop-startup.json"),
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      measurementClass:
        "fresh process/profile, warm OS and server cache; DOM readiness polled at 50 ms, not a paint timestamp",
      results,
    },
    null,
    2
  )
);
