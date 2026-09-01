import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { HostJobPayload, HostJobResponse } from "./host-job-protocol";

const MAX_CONCURRENT_JOBS = 2;
export const MAX_QUEUED_HOST_JOBS = 32;
const JOB_RESPONSE_TIMEOUT_MS = 2 * 60 * 60 * 1_000 + 60_000;

interface QueueEntry {
  id: string;
  payload: HostJobPayload;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onQueuedAbort?: () => void;
}

interface PendingEntry extends QueueEntry {
  timeout: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

export class HostJobManager {
  private child: UtilityProcess | null = null;
  private queue: QueueEntry[] = [];
  private pending = new Map<string, PendingEntry>();
  private closing = false;

  run = (payload: HostJobPayload, signal?: AbortSignal): Promise<unknown> => {
    if (this.closing) return Promise.reject(new Error("Host jobs are shutting down"));
    if (signal?.aborted) return Promise.reject(new Error("Host job was cancelled"));
    if (this.queue.length >= MAX_QUEUED_HOST_JOBS) {
      return Promise.reject(
        new Error(`Host job queue is full (${MAX_QUEUED_HOST_JOBS} waiting jobs)`)
      );
    }
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = { id: crypto.randomUUID(), payload, resolve, reject, signal };
      const abortQueued = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(new Error("Host job was cancelled"));
      };
      entry.onQueuedAbort = abortQueued;
      this.queue.push(entry);
      signal?.addEventListener("abort", abortQueued, { once: true });
      this.drain();
    });
  };

  private ensureChild() {
    if (this.child) return this.child;
    const child = utilityProcess.fork(join(import.meta.dirname, "host-utility.js"), [], {
      serviceName: "OpenBot Host Jobs",
      stdio: "pipe",
    });
    child.on("message", (message: unknown) => this.onMessage(message));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      const error = new Error(`Host utility process exited (${code})`);
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timeout);
        if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
        entry.reject(error);
      }
      this.pending.clear();
      if (!this.closing) this.drain();
    });
    child.stdout?.on("data", (chunk: Buffer) => console.info(`[host-jobs] ${chunk}`));
    child.stderr?.on("data", (chunk: Buffer) => console.error(`[host-jobs] ${chunk}`));
    this.child = child;
    return child;
  }

  private drain() {
    if (this.closing) return;
    while (this.pending.size < MAX_CONCURRENT_JOBS && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.onQueuedAbort) {
        entry.signal?.removeEventListener("abort", entry.onQueuedAbort);
        entry.onQueuedAbort = undefined;
      }
      if (entry.signal?.aborted) {
        entry.reject(new Error("Host job was cancelled"));
        continue;
      }
      let child: UtilityProcess;
      try {
        child = this.ensureChild();
      } catch (error) {
        entry.reject(
          error instanceof Error ? error : new Error("Could not start host utility process")
        );
        continue;
      }
      const timeout = setTimeout(() => {
        try {
          child.postMessage({ type: "cancel", id: entry.id });
        } catch {
          // The timeout result is authoritative even if the utility process already exited.
        }
        this.finish(entry.id, new Error("Host job timed out"));
      }, JOB_RESPONSE_TIMEOUT_MS);
      const onAbort = entry.signal
        ? () => {
            try {
              child.postMessage({ type: "cancel", id: entry.id });
            } catch {
              // The caller still gets a prompt cancellation if the child is already gone.
            }
            this.finish(entry.id, new Error("Host job was cancelled"));
          }
        : undefined;
      if (onAbort) entry.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(entry.id, { ...entry, timeout, onAbort });
      try {
        child.postMessage({ type: "run", id: entry.id, payload: entry.payload });
      } catch (error) {
        this.finish(
          entry.id,
          error instanceof Error ? error : new Error("Could not start host job")
        );
      }
    }
  }

  private onMessage(message: unknown) {
    if (!message || typeof message !== "object") return;
    const response = message as Partial<HostJobResponse>;
    if (response.type !== "result" || typeof response.id !== "string") return;
    if (response.ok === true) this.finish(response.id, undefined, response.value);
    else {
      const error =
        "error" in response && typeof response.error === "string"
          ? response.error
          : "Host job failed";
      this.finish(response.id, new Error(error));
    }
  }

  private finish(id: string, error?: Error, value?: unknown) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timeout);
    if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
    if (error) entry.reject(error);
    else entry.resolve(value);
    this.drain();
  }

  close() {
    this.closing = true;
    const error = new Error("Host jobs are shutting down");
    for (const entry of this.queue.splice(0)) {
      if (entry.onQueuedAbort) entry.signal?.removeEventListener("abort", entry.onQueuedAbort);
      entry.reject(error);
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
      entry.reject(error);
    }
    this.pending.clear();
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        // An explicit message lets Windows and POSIX both drain process trees with the
        // same graceful-then-forced policy before the utility exits itself.
        child.postMessage({ type: "shutdown" });
      } catch {
        child.kill();
      }
    }
  }
}
