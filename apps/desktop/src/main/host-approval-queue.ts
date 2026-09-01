export const MAX_ACTIVE_HOST_APPROVALS = 1;
export const MAX_QUEUED_HOST_APPROVALS = 32;

interface ApprovalEntry {
  show: () => Promise<boolean>;
  resolve: (allowed: boolean) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onQueuedAbort?: () => void;
}

const cancelled = () => new Error("Host approval was cancelled");

/**
 * Native message boxes are intentionally serialized. Besides avoiding a stack of
 * overlapping modal dialogs, this bounds the number of pending native promises an
 * authenticated request burst can create before host-job admission takes effect.
 */
export class HostApprovalQueue {
  private active = 0;
  private readonly queue: ApprovalEntry[] = [];

  constructor(
    private readonly maxActive = MAX_ACTIVE_HOST_APPROVALS,
    private readonly maxQueued = MAX_QUEUED_HOST_APPROVALS
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error("Host approvals must allow at least one active dialog");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("Host approval queue capacity must be non-negative");
    }
  }

  request(show: () => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.active >= this.maxActive && this.queue.length >= this.maxQueued) {
      return Promise.reject(
        new Error(`Host approval queue is full (${this.maxQueued} waiting requests)`)
      );
    }

    return new Promise((resolve, reject) => {
      const entry: ApprovalEntry = { show, resolve, reject, signal };
      const onQueuedAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(cancelled());
      };
      entry.onQueuedAbort = onQueuedAbort;
      signal?.addEventListener("abort", onQueuedAbort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }

  snapshot() {
    return { active: this.active, queued: this.queue.length };
  }

  private drain() {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.onQueuedAbort) {
        entry.signal?.removeEventListener("abort", entry.onQueuedAbort);
        entry.onQueuedAbort = undefined;
      }
      if (entry.signal?.aborted) {
        entry.reject(cancelled());
        continue;
      }
      this.active += 1;
      void this.show(entry);
    }
  }

  private async show(entry: ApprovalEntry) {
    try {
      const allowed = await entry.show();
      if (entry.signal?.aborted) entry.reject(cancelled());
      else entry.resolve(allowed);
    } catch (error) {
      entry.reject(error);
    } finally {
      this.active -= 1;
      this.drain();
    }
  }
}
