import type { StreamingTts } from "./voice-provider";

const DEFAULT_TTL_MS = 15_000;

/**
 * Keeps one synthesis connection already open so the next spoken line does not pay
 * the WebSocket handshake. An unused connection is closed after a short time, and a
 * failed warm-up is invisible: take() then opens a fresh connection instead.
 */
export class WarmTtsPool {
  private ready: Promise<StreamingTts> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly open: () => Promise<StreamingTts>,
    private readonly ttlMs = DEFAULT_TTL_MS
  ) {}

  /** Starts opening a connection unless one is already waiting. */
  warm(): void {
    if (this.closed || this.ready) return;
    const pending = this.open();
    // A warm-up that fails is dropped here; the caller never sees its rejection.
    pending.catch(() => {
      if (this.ready === pending) this.discard();
    });
    this.ready = pending;
    this.timer = setTimeout(() => this.discard(), this.ttlMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Hands over the warm connection if there is one, then starts warming the next. */
  async take(): Promise<{ stream: StreamingTts; warmed: boolean }> {
    const pending = this.ready;
    this.ready = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (pending) {
      try {
        const stream = await pending;
        this.warm();
        return { stream, warmed: true };
      } catch {
        // Fall through to a cold connection.
      }
    }
    const stream = await this.open();
    this.warm();
    return { stream, warmed: false };
  }

  close(): void {
    this.closed = true;
    this.discard();
  }

  private discard(): void {
    const pending = this.ready;
    this.ready = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void pending?.then((stream) => stream.cancel()).catch(() => undefined);
  }
}
