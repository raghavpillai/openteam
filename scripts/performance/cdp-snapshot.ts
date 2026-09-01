const endpoint = process.env.OPENBOT_AUDIT_CDP_URL ?? "http://127.0.0.1:9333";
const label = process.argv[2] ?? "snapshot";

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as Target[];
const target = targets.find(
  (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl
);
if (!target?.webSocketDebuggerUrl) throw new Error(`No Electron page target at ${endpoint}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolveOpen, reject) => {
  socket.addEventListener("open", () => resolveOpen(), { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), {
    once: true,
  });
});

let nextId = 1;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as {
    id?: number;
    result?: unknown;
    error?: { message?: string };
  };
  if (typeof message.id !== "number") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message ?? "CDP command failed"));
  else waiter.resolve(message.result);
});

const command = <T>(method: string, params: Record<string, unknown> = {}) =>
  new Promise<T>((resolveCommand, reject) => {
    const id = nextId++;
    pending.set(id, {
      resolve: (value) => resolveCommand(value as T),
      reject: reject,
    });
    socket.send(JSON.stringify({ id, method, params }));
  });

await Promise.all([
  command("Performance.enable"),
  command("Runtime.enable"),
  command("DOM.enable"),
]);
if (process.env.OPENBOT_AUDIT_COLLECT_GARBAGE === "1") {
  await command("HeapProfiler.collectGarbage");
}

const expression = String.raw`(async () => {
  const frameGaps = [];
  let previous = performance.now();
  for (let index = 0; index < 120; index += 1) {
    await new Promise(requestAnimationFrame);
    const now = performance.now();
    frameGaps.push(now - previous);
    previous = now;
  }
  const resources = performance.getEntriesByType("resource").map((entry) => ({
    name: entry.name,
    startTime: entry.startTime,
    duration: entry.duration,
    transferSize: entry.transferSize,
    decodedBodySize: entry.decodedBodySize,
  }));
  const heap = performance.memory ? {
    usedJSHeapSize: performance.memory.usedJSHeapSize,
    totalJSHeapSize: performance.memory.totalJSHeapSize,
    jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
  } : null;
  const transcript = document.querySelector('[role="log"]');
  const virtualTimeline = document.querySelector('[data-virtual-timeline-count]');
  let timelineScroll = virtualTimeline?.parentElement ?? null;
  while (
    timelineScroll &&
    timelineScroll.scrollHeight <= timelineScroll.clientHeight + 1
  ) {
    timelineScroll = timelineScroll.parentElement;
  }
  const newestButton = document.querySelector(
    'button[aria-label="Scroll to newest message"], button[aria-label="Jump to latest message"]'
  );
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    elements: document.getElementsByTagName("*").length,
    buttons: document.querySelectorAll("button").length,
    images: document.images.length,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    virtualization: {
      sidebarEnabled: document.querySelector('[data-sidebar-virtualized="true"]') !== null,
      mountedChannelRows: document.querySelectorAll('[data-channel-id]').length,
      mountedPinnedRows: document.querySelectorAll('[data-pinned-channel-id]').length,
      declaredSidebarRows: [...document.querySelectorAll('[data-virtual-sidebar-count]')]
        .map((element) => Number(element.getAttribute('data-virtual-sidebar-count')) || 0),
      declaredPinnedRows: [...document.querySelectorAll('[data-virtual-pinned-sidebar-count]')]
        .map((element) => Number(element.getAttribute('data-virtual-pinned-sidebar-count')) || 0),
      declaredSections: [...document.querySelectorAll('[data-virtual-sidebar-sections]')]
        .map((element) => Number(element.getAttribute('data-virtual-sidebar-sections')) || 0),
      mountedCompactRows: document.querySelectorAll('[data-compact-channel-id]').length,
      declaredCompactRows: [...document.querySelectorAll('[data-virtual-compact-sidebar-count]')]
        .map((element) => Number(element.getAttribute('data-virtual-compact-sidebar-count')) || 0),
      mountedTimelineRows: document.querySelectorAll('[data-virtual-timeline-index]').length,
      declaredTimelines: [...document.querySelectorAll('[data-virtual-timeline-count]')]
        .map((element) => Number(element.getAttribute('data-virtual-timeline-count')) || 0),
      memberEditorOpen: document.querySelector('[data-group-member-editor]') !== null,
      mountedMemberRows: document.querySelectorAll('[data-member-bot-id]').length,
      declaredMemberRows: [...document.querySelectorAll('[aria-label$=" matching bots"]')]
        .map((element) => Number(element.getAttribute('aria-label')?.split(' ')[0]) || 0),
    },
    scroll: transcript ? {
      top: transcript.scrollTop,
      height: transcript.scrollHeight,
      viewport: transcript.clientHeight,
      bottomDistance: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
    } : null,
    timelineScroll: timelineScroll ? {
      top: timelineScroll.scrollTop,
      height: timelineScroll.scrollHeight,
      viewport: timelineScroll.clientHeight,
      bottomDistance:
        timelineScroll.scrollHeight - timelineScroll.clientHeight - timelineScroll.scrollTop,
    } : null,
    newestButton: newestButton ? {
      ariaHidden: newestButton.getAttribute('aria-hidden'),
      tabIndex: newestButton.tabIndex,
      opacity: getComputedStyle(newestButton).opacity,
      pointerEvents: getComputedStyle(newestButton).pointerEvents,
    } : null,
    scrollCandidates: [...document.querySelectorAll('*')]
      .filter((element) => element.scrollHeight > element.clientHeight + 1)
      .map((element) => ({
        role: element.getAttribute('role'),
        className: element.className,
        top: element.scrollTop,
        height: element.scrollHeight,
        viewport: element.clientHeight,
        bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
      }))
      .slice(0, 12),
    heap,
    navigation: performance.getEntriesByType("navigation")[0]?.toJSON?.() ?? null,
    resourceCount: resources.length,
    resourceBytes: resources.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
    resources,
    frameGaps: {
      samples: frameGaps.length,
      max: Math.max(...frameGaps),
      over20ms: frameGaps.filter((value) => value > 20).length,
      over50ms: frameGaps.filter((value) => value > 50).length,
    },
    openbot: window.openbotPerformance?.snapshot?.() ?? null,
    processes: await window.openbot?.getProcessMetrics?.() ?? null,
  };
})()`;

const [dom, runtime, performanceMetrics, evaluated] = await Promise.all([
  command<{ documents: number; nodes: number; jsEventListeners: number }>("Memory.getDOMCounters"),
  command<{ usedSize: number; totalSize: number }>("Runtime.getHeapUsage"),
  command<{ metrics: Array<{ name: string; value: number }> }>("Performance.getMetrics"),
  command<{
    result: { value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { text?: string };
  }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }),
]);

if (evaluated.exceptionDetails) {
  throw new Error(
    evaluated.exceptionDetails.text ?? evaluated.result.description ?? "Evaluation failed"
  );
}

const report = {
  label,
  capturedAt: new Date().toISOString(),
  target: { type: target.type, url: target.url },
  dom,
  runtime,
  performance: Object.fromEntries(
    performanceMetrics.metrics.map((metric) => [metric.name, metric.value])
  ),
  page: evaluated.result.value,
};
const serialized = JSON.stringify(report, null, 2);
if (process.env.OPENBOT_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENBOT_AUDIT_OUTPUT, `${serialized}\n`);
}
console.log(serialized);
socket.close();
