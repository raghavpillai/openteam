import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Instrumentation only. All clicks, typing and scrolling are performed through CUA.
const endpoint = process.env.OPENTEAM_AUDIT_CDP_URL ?? "http://127.0.0.1:9334";
const output = resolve(process.env.OPENTEAM_AUDIT_OUTPUT ?? "/tmp/openteam-desktop-profile");
const durationMs = Number(process.env.OPENTEAM_AUDIT_PROFILE_MS ?? 30_000);
if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 180_000)
  throw new Error("Invalid profile duration");
await mkdir(output, { recursive: true });
const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as Array<{
  type: string;
  webSocketDebuggerUrl?: string;
}>;
const target = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!target?.webSocketDebuggerUrl) throw new Error("No Electron page target");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (cause: Error) => void }
>();
let traceComplete!: (stream: string) => void;
const tracingComplete = new Promise<string>((resolve) => {
  traceComplete = resolve;
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "Tracing.tracingComplete") traceComplete(message.params.stream);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
const command = <T = any>(method: string, params: Record<string, unknown> = {}) =>
  new Promise<T>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression: string) => {
  const response = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
};
try {
  await command("HeapProfiler.enable");
  await command("HeapProfiler.collectGarbage");
  const beforeHeap = await command("Runtime.getHeapUsage");
  await evaluate(`(() => {
    window.openteamPerformance?.clear();
    const startedAt = performance.now();
    const frames = [], longTasks = [], interactions = [], observers = [];
    let previous = null, raf = 0;
    const frame = (at) => { if (previous !== null) frames.push({ at, duration: at - previous, visible: document.visibilityState === 'visible', focused: document.hasFocus() }); previous = at; raf = requestAnimationFrame(frame); };
    raf = requestAnimationFrame(frame);
    for (const [type, values] of [['longtask', longTasks], ['event', interactions]]) {
      try { const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) values.push({ name:e.name, startTime:e.startTime, duration:e.duration, processingStart:e.processingStart, processingEnd:e.processingEnd, interactionId:e.interactionId }); }); observer.observe({ type, buffered: false, durationThreshold: 16 }); observers.push(observer); } catch {}
    }
    globalThis.__openteamRuntimeProfile = { finish: async () => {
      cancelAnimationFrame(raf); for (const observer of observers) observer.disconnect();
      const result = { startedAt, endedAt:performance.now(), frames, longTasks, interactions,
        app: await window.openteamPerformance?.export(),
        navigation: performance.getEntriesByType('navigation').map(e=>e.toJSON()),
        paints: performance.getEntriesByType('paint').map(e=>e.toJSON()),
        resources: performance.getEntriesByType('resource').filter(e=>e.startTime>=startedAt).map(e=>({name:e.name, duration:e.duration, transferSize:e.transferSize, decodedBodySize:e.decodedBodySize})),
        dom: { elements:document.querySelectorAll('*').length, messageRows:document.querySelectorAll('.message-row').length },
        viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}, location:location.href };
      delete globalThis.__openteamRuntimeProfile; return result;
    }};
  })()`);
  await command("Profiler.enable");
  await command("Profiler.setSamplingInterval", { interval: 1000 });
  await command("Profiler.start");
  await command("Tracing.start", {
    categories: "devtools.timeline,blink.user_timing,v8,cc,latencyInfo",
    transferMode: "ReturnAsStream",
  });
  console.log(`PROFILE_READY ${durationMs}ms ${output}`);
  await Bun.sleep(durationMs);
  const { profile } = await command("Profiler.stop");
  await command("Tracing.end");
  const capture = await evaluate("globalThis.__openteamRuntimeProfile.finish()");
  const afterHeap = await command("Runtime.getHeapUsage");
  await command("HeapProfiler.collectGarbage");
  const afterGcHeap = await command("Runtime.getHeapUsage");
  const stream = await tracingComplete;
  const trace: string[] = [];
  while (true) {
    const part = await command("IO.read", { handle: stream });
    trace.push(part.base64Encoded ? Buffer.from(part.data, "base64").toString() : part.data);
    if (part.eof) break;
  }
  await command("IO.close", { handle: stream });
  await writeFile(resolve(output, "cpu.cpuprofile"), JSON.stringify(profile));
  await writeFile(resolve(output, "timeline.json"), trace.join(""));
  await writeFile(
    resolve(output, "capture.json"),
    JSON.stringify({ ...capture, beforeHeap, afterHeap, afterGcHeap }, null, 2)
  );
  const visible = capture.frames
    .filter(
      (frame: any) =>
        frame.visible &&
        frame.focused &&
        frame.at > capture.startedAt + 250 &&
        frame.at < capture.endedAt - 250
    )
    .map((frame: any) => frame.duration)
    .sort((a: number, b: number) => a - b);
  const percentile = (fraction: number) =>
    visible[Math.min(visible.length - 1, Math.ceil(visible.length * fraction) - 1)] ?? null;
  const durations = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i += 1)
    durations.set(
      profile.samples[i],
      (durations.get(profile.samples[i]) ?? 0) + Math.max(0, profile.timeDeltas[i])
    );
  const hottest = profile.nodes
    .map((node: any) => ({ ...node.callFrame, selfMs: (durations.get(node.id) ?? 0) / 1000 }))
    .sort((a: any, b: any) => b.selfMs - a.selfMs)
    .slice(0, 25);
  const summary = {
    durationMs: capture.endedAt - capture.startedAt,
    observedFrames: capture.frames.length,
    focusedVisibleFrames: visible.length,
    frameP50Ms: percentile(0.5),
    frameP95Ms: percentile(0.95),
    frameP99Ms: percentile(0.99),
    framesOver25Ms: visible.filter((ms: number) => ms > 25).length,
    longTasks: capture.longTasks.length,
    longTaskTotalMs: capture.longTasks.reduce((n: number, task: any) => n + task.duration, 0),
    interactions: capture.interactions,
    appMetrics: capture.app?.summary,
    retainedHeapBytes: afterGcHeap.usedSize,
    beforeHeapBytes: beforeHeap.usedSize,
    dom: capture.dom,
    hottest,
  };
  await writeFile(resolve(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await command("Profiler.disable").catch(() => undefined);
  socket.close();
}
