import { cleanupSessionResources } from "@earendil-works/pi-ai";

/** Retain only provider transport resources between turns, never an AgentSession. */
export class IdleProviderConnections {
  private readonly idle = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly ttlMs = 120_000,
    private readonly capacity = 64,
    private readonly release: (sessionId: string) => void = cleanupSessionResources
  ) {}

  acquire(sessionId: string): void {
    const timer = this.idle.get(sessionId);
    if (timer) clearTimeout(timer);
    this.idle.delete(sessionId);
  }

  retain(sessionId: string): void {
    this.acquire(sessionId);
    if (this.closed || this.capacity < 1) {
      this.dispose(sessionId);
      return;
    }
    while (this.idle.size >= this.capacity) {
      this.dispose(this.idle.keys().next().value!);
    }
    const timer = setTimeout(() => this.dispose(sessionId), this.ttlMs);
    timer.unref();
    this.idle.set(sessionId, timer);
  }

  dispose(sessionId: string): void {
    this.acquire(sessionId);
    try {
      this.release(sessionId);
    } catch {
      console.warn("Provider connection cleanup failed");
    }
  }

  clear(): void {
    for (const sessionId of this.idle.keys()) this.dispose(sessionId);
  }

  close(): void {
    this.closed = true;
    this.clear();
  }
}

interface InferenceConnection {
  key: string;
  busy: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Exclusive transport leases for independent, full-context inference calls. */
export class InferenceProviderConnections {
  private readonly entries = new Map<string, InferenceConnection>();
  private closed = false;

  constructor(
    private readonly capacity = 8,
    private readonly ttlMs = 120_000,
    private readonly cleanup: (sessionId: string) => void = cleanupSessionResources
  ) {}

  acquire(key: string): { sessionId?: string; release: (reusable: boolean) => void } {
    if (this.closed || this.capacity < 1) return { release() {} };
    let id: string | undefined;
    for (const [candidate, entry] of this.entries) {
      if (!entry.busy && entry.key === key) { id = candidate; break; }
    }
    if (!id && this.entries.size >= this.capacity) {
      const idle = [...this.entries].find(([, entry]) => !entry.busy);
      if (idle) this.dispose(idle[0]);
      // Overflow keeps the pre-existing fresh-connection behavior; never queue
      // independent reviews behind a busy socket or share its response stream.
      else return { release() {} };
    }
    if (!id) {
      id = `inference:${crypto.randomUUID()}`;
      this.entries.set(id, { key, busy: false });
    }
    const sessionId = id;
    const entry = this.entries.get(sessionId)!;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.busy = true;
    let released = false;
    return {
      sessionId,
      release: (reusable) => {
        if (released) return;
        released = true;
        if (this.entries.get(sessionId) !== entry) return;
        if (!reusable || this.closed) { this.dispose(sessionId); return; }
        entry.busy = false;
        entry.timer = setTimeout(() => this.dispose(sessionId), this.ttlMs);
        entry.timer.unref();
      },
    };
  }

  private dispose(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(sessionId);
    try { this.cleanup(sessionId); }
    catch { console.warn("Inference connection cleanup failed"); }
  }

  clear(): void {
    for (const id of this.entries.keys()) this.dispose(id);
  }

  close(): void {
    this.closed = true;
    this.clear();
  }
}
