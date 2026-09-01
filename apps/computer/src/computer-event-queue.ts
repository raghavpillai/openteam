import type { ComputerEvent } from "@openbot/contracts";
import { AsyncQueue } from "./async-queue";

export const AGENT_DELTA_FLUSH_INTERVAL_MS = 32;
export const AGENT_DELTA_MAX_CHARS = 4_096;

/**
 * Coalesces adjacent assistant token fragments without changing event order.
 * Boundary events synchronously flush pending text, while the timer bounds
 * partial-message durability latency during a long generation.
 */
export class ComputerEventQueue implements AsyncIterable<ComputerEvent> {
  private readonly queue = new AsyncQueue<ComputerEvent>();
  private pendingDelta: Extract<ComputerEvent, { type: "agent.delta" }> | null = null;
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;

  push(event: ComputerEvent): void {
    if (event.type !== "agent.delta") {
      this.flushDelta();
      this.queue.push(event);
      return;
    }

    if (
      this.pendingDelta &&
      (this.pendingDelta.turnId !== event.turnId || this.pendingDelta.itemId !== event.itemId)
    ) {
      this.flushDelta();
    }
    if (this.pendingDelta) {
      this.pendingDelta.delta += event.delta;
    } else {
      this.pendingDelta = { ...event };
    }

    if (this.pendingDelta.delta.length >= AGENT_DELTA_MAX_CHARS) {
      this.flushDelta();
      return;
    }
    if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => this.flushDelta(), AGENT_DELTA_FLUSH_INTERVAL_MS);
      this.deltaTimer.unref?.();
    }
  }

  end(): void {
    this.flushDelta();
    this.queue.end();
  }

  fail(error: unknown): void {
    this.flushDelta();
    this.queue.fail(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<ComputerEvent> {
    return this.queue[Symbol.asyncIterator]();
  }

  private flushDelta(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    const pending = this.pendingDelta;
    this.pendingDelta = null;
    if (pending) this.queue.push(pending);
  }
}
