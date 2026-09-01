export interface OpenBotPerformanceEntry {
  name: string;
  duration: number;
  at: number;
  detail?: Record<string, number | string | boolean>;
}

export type OpenBotPerformanceScenario = Record<string, number | string | boolean>;

export interface OpenBotPerformanceExport {
  exportedAt: number;
  scenario: OpenBotPerformanceScenario;
  entries: OpenBotPerformanceEntry[];
  summary: Record<string, { count: number; average: number; p95: number; max: number }>;
  processes: Awaited<ReturnType<NonNullable<Window["openbot"]>["getProcessMetrics"]>> | null;
}

const MAX_ENTRIES = 200;
const fallbackEntries: OpenBotPerformanceEntry[] = [];

interface PerformanceStore {
  entries: OpenBotPerformanceEntry[];
  installed: boolean;
  revision: number;
  scenario: OpenBotPerformanceScenario;
}

const currentScenario = (): OpenBotPerformanceScenario => {
  const parameters = new URLSearchParams(window.location.search);
  return {
    name: parameters.get("scenario") ?? "interactive",
    variant: parameters.get("variant") ?? "current",
    fixture: parameters.get("fixture") ?? "default",
    profile: parameters.has("profile"),
    startedAt: Date.now(),
    pathname: window.location.pathname,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    platform: window.openbot?.platform ?? navigator.platform,
    electron: window.openbot?.versions.electron ?? "browser",
    chrome: window.openbot?.versions.chrome ?? "browser",
  };
};

const getStore = (): PerformanceStore | null => {
  if (typeof window === "undefined") return null;
  if (!window.__openbotPerformanceStore) {
    window.__openbotPerformanceStore = {
      entries: [],
      installed: false,
      revision: 0,
      scenario: currentScenario(),
    };
  }
  return window.__openbotPerformanceStore;
};

export function recordPerformance(
  name: string,
  duration: number,
  detail?: OpenBotPerformanceEntry["detail"]
) {
  const store = getStore();
  const entries = store?.entries ?? fallbackEntries;
  entries.push({ name, duration, at: Date.now(), detail });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  if (store) store.revision += 1;
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
    clear: () => {
      store.entries.splice(0);
      store.revision += 1;
    },
    metadata: () => ({ ...store.scenario }),
    setScenario: (metadata: OpenBotPerformanceScenario) => {
      store.scenario = { ...store.scenario, ...metadata };
      store.revision += 1;
    },
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
              p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
              max: sorted.at(-1) ?? 0,
            },
          ];
        })
      );
    },
    export: async (): Promise<OpenBotPerformanceExport> => ({
      exportedAt: Date.now(),
      scenario: { ...store.scenario },
      entries: store.entries.slice(),
      summary: debug.summary(),
      processes: window.openbot?.getProcessMetrics
        ? await window.openbot.getProcessMetrics().catch(() => null)
        : null,
    }),
  };
  Object.defineProperty(window, "openbotPerformance", {
    configurable: true,
    value: debug,
  });

  if (import.meta.env.DEV || new URLSearchParams(window.location.search).has("profile")) {
    let publishedRevision = -1;
    const publish = () => {
      if (publishedRevision === store.revision) return;
      publishedRevision = store.revision;
      document.documentElement.dataset.openbotPerformance = JSON.stringify(debug.summary());
      document.documentElement.dataset.openbotPerformanceRecent = JSON.stringify(
        store.entries.slice(-50)
      );
      document.documentElement.dataset.openbotPerformanceScenario = JSON.stringify(
        debug.metadata()
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
      metadata: () => OpenBotPerformanceScenario;
      setScenario: (metadata: OpenBotPerformanceScenario) => void;
      summary: () => Record<string, { count: number; average: number; p95: number; max: number }>;
      export: () => Promise<OpenBotPerformanceExport>;
    };
  }
}
