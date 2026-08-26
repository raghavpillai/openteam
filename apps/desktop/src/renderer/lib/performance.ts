export interface OpenBotPerformanceEntry {
  name: string;
  duration: number;
  at: number;
  detail?: Record<string, number | string | boolean>;
}

const MAX_ENTRIES = 200;
const fallbackEntries: OpenBotPerformanceEntry[] = [];

interface PerformanceStore {
  entries: OpenBotPerformanceEntry[];
  installed: boolean;
}

const getStore = (): PerformanceStore | null => {
  if (typeof window === "undefined") return null;
  if (!window.__openbotPerformanceStore) {
    window.__openbotPerformanceStore = { entries: [], installed: false };
  }
  return window.__openbotPerformanceStore;
};

const getEntries = () => getStore()?.entries ?? fallbackEntries;

export function recordPerformance(
  name: string,
  duration: number,
  detail?: OpenBotPerformanceEntry["detail"]
) {
  const entries = getEntries();
  entries.push({ name, duration, at: Date.now(), detail });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function measureUntilNextPaint(name: string, detail?: OpenBotPerformanceEntry["detail"]) {
  const startedAt = performance.now();
  requestAnimationFrame(() => {
    window.setTimeout(() => recordPerformance(name, performance.now() - startedAt, detail), 0);
  });
}

export function installPerformanceMonitoring() {
  const store = getStore();
  if (!store || store.installed) return;
  store.installed = true;
  const debug = {
    snapshot: () => store.entries.slice(),
    clear: () => store.entries.splice(0),
    summary: () => {
      const grouped = new Map<string, number[]>();
      for (const entry of store.entries) {
        const values = grouped.get(entry.name);
        if (values) values.push(entry.duration);
        else grouped.set(entry.name, [entry.duration]);
      }
      return Object.fromEntries(
        [...grouped].map(([name, values]) => {
          const sorted = values.slice().sort((a, b) => a - b);
          return [
            name,
            {
              count: values.length,
              average: values.reduce((sum, value) => sum + value, 0) / values.length,
              p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
              max: sorted.at(-1) ?? 0,
            },
          ];
        })
      );
    },
  };
  Object.defineProperty(window, "openbotPerformance", {
    configurable: true,
    value: debug,
  });

  if (import.meta.env.DEV || new URLSearchParams(window.location.search).has("profile")) {
    let publishedCount = -1;
    const publish = () => {
      if (publishedCount === store.entries.length) return;
      publishedCount = store.entries.length;
      document.documentElement.dataset.openbotPerformance = JSON.stringify(debug.summary());
      document.documentElement.dataset.openbotPerformanceRecent = JSON.stringify(
        store.entries.slice(-50)
      );
    };
    publish();
    window.setInterval(publish, 500);
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => recordPerformance("startup.first-ui-paint", performance.now()));
  });

  if (!("PerformanceObserver" in window)) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordPerformance("browser.long-task", entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Long-task entries are not available in every Electron/Chromium build.
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        recordPerformance(`browser.${entry.name}`, entry.startTime);
    });
    observer.observe({ type: "paint", buffered: true });
  } catch {
    // Paint entries are best-effort diagnostics.
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 16 || !["click", "keydown"].includes(entry.name)) continue;
        recordPerformance("browser.interaction", entry.duration, { event: entry.name });
      }
    });
    observer.observe({
      type: "event",
      buffered: true,
      durationThreshold: 16,
    } as PerformanceObserverInit & { durationThreshold: number });
  } catch {
    // Event Timing is not available in every Electron/Chromium build.
  }
}

declare global {
  interface Window {
    __openbotPerformanceStore?: PerformanceStore;
    openbotPerformance?: {
      snapshot: () => OpenBotPerformanceEntry[];
      clear: () => void;
      summary: () => Record<string, { count: number; average: number; p95: number; max: number }>;
    };
  }
}
