import type { TokensResult } from "shiki/core";
import type { ThemeInput } from "streamdown";
import { isWindowActive, subscribeWindowActivity } from "../../../lib/window-visibility";

// The renderer owns the bounded token cache; the worker owns grammar instances.
// Never fall back to synchronous tokenization on the renderer after a worker error.
let worker: Worker | undefined;
let nextId = 0;
let stats = { activeCreations: 0, creationQueue: 0, highlighterEntries: 0 };
let localEngine: typeof import("./code-engine") | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribeActivity: (() => void) | undefined;
const BACKGROUND_IDLE_MS = 30_000;
const pending = new Map<number, {
  resolve: (result: TokensResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const resetWorker = (error: Error) => {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  unsubscribeActivity?.();
  unsubscribeActivity = undefined;
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
  }
  worker?.terminate();
  worker = undefined;
  stats = { activeCreations: 0, creationQueue: 0, highlighterEntries: 0 };
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
};

const scheduleIdleRelease = () => {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  if (!worker || pending.size > 0 || isWindowActive()) return;
  idleTimer = setTimeout(() => {
    if (pending.size === 0 && !isWindowActive()) {
      resetWorker(new Error("Idle code highlighting worker released"));
    }
  }, BACKGROUND_IDLE_MS);
};

export const highlightAsync = async (
  source: string,
  language: string,
  themes: [ThemeInput, ThemeInput]
): Promise<TokensResult> => {
  // Server-side rendering and unit tests have no browser worker environment.
  if (typeof window === "undefined") {
    const enginePath = "./code-engine";
    localEngine ??= await import(/* @vite-ignore */ enginePath);
    return localEngine!.highlightAsync(source, language, themes);
  }
  clearTimeout(idleTimer);
  idleTimer = undefined;
  if (!worker) {
    const current = new Worker(new URL("./code.worker.ts", import.meta.url), { type: "module" });
    worker = current;
    unsubscribeActivity = subscribeWindowActivity(scheduleIdleRelease);
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.stats) stats = data.stats;
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
      scheduleIdleRelease();
    };
    current.onerror = () => {
      if (worker === current) resetWorker(new Error("Code highlighting worker failed"));
    };
    current.onmessageerror = () => {
      if (worker === current) resetWorker(new Error("Invalid code highlighting response"));
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resetWorker(new Error("Code highlighting timed out")), 30_000);
    pending.set(id, { resolve, reject, timer });
    try { worker!.postMessage({ id, source, language, themes }); }
    catch (error) { resetWorker(error instanceof Error ? error : new Error(String(error))); }
  });
};

export const getHighlightEngineStats = () => localEngine?.getEngineStats() ?? stats;
export const clearHighlightEngine = () => {
  localEngine?.clearEngine();
  resetWorker(new Error("Code highlighting cache disposed"));
};
