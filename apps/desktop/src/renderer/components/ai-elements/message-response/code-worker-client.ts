import type { TokensResult } from "shiki/core";
import type { ThemeInput } from "streamdown";

// The renderer owns the bounded token cache; the worker owns grammar instances.
// Never fall back to synchronous tokenization on the renderer after a worker error.
let worker: Worker | undefined;
let nextId = 0;
let stats = { activeCreations: 0, creationQueue: 0, highlighterEntries: 0 };
let localEngine: typeof import("./code-engine") | undefined;
const pending = new Map<number, {
  resolve: (result: TokensResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const resetWorker = (error: Error) => {
  worker?.terminate();
  worker = undefined;
  stats = { activeCreations: 0, creationQueue: 0, highlighterEntries: 0 };
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
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
  if (!worker) {
    worker = new Worker(new URL("./code.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.stats) stats = data.stats;
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    worker.onerror = () => resetWorker(new Error("Code highlighting worker failed"));
    worker.onmessageerror = () => resetWorker(new Error("Invalid code highlighting response"));
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
