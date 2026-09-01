import { Client } from "pg";

const EVENT_CHANNEL = "openbot_events";
const RECONNECT_DELAY_MS = 1_000;
const UNHEALTHY_POLL_MS = 1_500;

/**
 * One LISTEN connection fans a commit notification out to every active SSE
 * response. The monotonically increasing version closes the query/wait race:
 * a notification arriving between an empty query and wait() resolves the wait
 * immediately.
 */
export class EventWakeup {
  private client: Client | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private stopped = false;
  private version = 0;

  constructor(private readonly databaseUrl: string) {}

  get currentVersion(): number {
    return this.version;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect().catch((error) => {
      console.warn("event LISTEN unavailable; SSE will use keepalive fallback", error);
      this.scheduleReconnect();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    this.notify();
    await client?.end().catch(() => undefined);
  }

  /** Exposed for deterministic tests and in-process fallback notifications. */
  notify(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  wait(afterVersion: number, timeoutMs: number, signal?: AbortSignal): Promise<number> {
    if (this.version !== afterVersion || signal?.aborted) return Promise.resolve(this.version);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve(this.version);
      };
      // LISTEN is an optimization, not a correctness dependency. Re-query the
      // event table promptly while disconnected so clients do not become stale
      // for the full healthy keepalive interval.
      const timer = setTimeout(
        finish,
        this.client ? timeoutMs : Math.min(timeoutMs, UNHEALTHY_POLL_MS)
      );
      timer.unref?.();
      this.listeners.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      // Recheck after subscribing so no notification can fall through the gap.
      if (this.version !== afterVersion) finish();
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.client) return;
    const client = new Client({ connectionString: this.databaseUrl });
    client.on("notification", (message) => {
      if (message.channel === EVENT_CHANNEL) this.notify();
    });
    client.on("error", (error) => {
      if (this.client !== client) return;
      this.client = null;
      console.warn("event LISTEN disconnected", error);
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    });
    client.on("end", () => {
      if (this.client !== client) return;
      this.client = null;
      console.warn("event LISTEN connection ended; reconnecting");
      this.scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENT_CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.stopped) {
      await client.end();
      return;
    }
    this.client = client;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        console.warn("event LISTEN reconnect failed", error);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }
}
