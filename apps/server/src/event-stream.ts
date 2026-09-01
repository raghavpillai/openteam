import type { ProductEvent } from "@openbot/contracts";

export const SSE_EVENT_BATCH_SIZE = 64;
const KEEPALIVE_INTERVAL_MS = 15_000;
const ERROR_RETRY_MS = 1_500;

type EventWindow = {
  oldest: bigint | null;
  latest: bigint | null;
  cursorExpired: boolean;
  cursorAhead: boolean;
  events: ProductEvent[];
};

export interface EventStreamSource {
  readonly eventVersion: number;
  eventWindowAfter(sequence: bigint, limit: number): Promise<EventWindow>;
  waitForEvent(version: number, timeoutMs: number, signal?: AbortSignal): Promise<number>;
}

const productEventChunk = (event: ProductEvent): string =>
  `id: ${event.sequence}\nevent: product\ndata: ${JSON.stringify(event)}\n\n`;

const abortableDelay = (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
};

/**
 * A pull-driven SSE body. The connected comment occupies the stream's single
 * queued chunk, so no event query runs until the HTTP peer consumes it. Every
 * subsequent pull performs at most one bounded event-window read and enqueues
 * that whole window as one chunk. A slow or suspended renderer therefore
 * cannot make the server materialize an unbounded replay backlog.
 */
export const eventStream = (
  source: EventStreamSource,
  initialCursor: bigint,
  requestSignal: AbortSignal,
  encoder = new TextEncoder()
): ReadableStream<Uint8Array> => {
  let cursor = initialCursor;
  let closed = false;
  let retryAfter = 0;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const lifetime = new AbortController();

  const cleanup = () => requestSignal.removeEventListener("abort", onRequestAbort);
  const close = () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    cleanup();
    try {
      streamController?.close();
    } catch {
      // The HTTP peer may have already canceled its body.
    }
  };
  const onRequestAbort = () => close();
  requestSignal.addEventListener("abort", onRequestAbort, { once: true });

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        if (requestSignal.aborted) {
          close();
          return;
        }
        controller.enqueue(encoder.encode(": connected\n\n"));
      },

      async pull(controller) {
        if (closed || lifetime.signal.aborted) {
          close();
          return;
        }

        await abortableDelay(Math.max(0, retryAfter - Date.now()), lifetime.signal);
        if (closed || lifetime.signal.aborted) {
          close();
          return;
        }

        try {
          const observedVersion = source.eventVersion;
          const window = await source.eventWindowAfter(cursor, SSE_EVENT_BATCH_SIZE);
          if (closed || lifetime.signal.aborted) return;

          if (window.cursorExpired || window.cursorAhead) {
            const replacementCursor = window.latest ?? 0n;
            const event: ProductEvent = {
              sequence: replacementCursor.toString(),
              topic: "snapshot.required",
              entityId: null,
              payload: {
                reason: window.cursorExpired ? "cursor_expired" : "cursor_ahead",
                oldestAvailable: window.oldest?.toString() ?? null,
                latestAvailable: window.latest?.toString() ?? null,
              },
              createdAt: new Date().toISOString(),
            };
            cursor = replacementCursor;
            controller.enqueue(encoder.encode(productEventChunk(event)));
            return;
          }

          if (window.events.length > 0) {
            cursor = BigInt(window.events.at(-1)?.sequence ?? cursor);
            controller.enqueue(encoder.encode(window.events.map(productEventChunk).join("")));
            return;
          }

          const nextVersion = await source.waitForEvent(
            observedVersion,
            KEEPALIVE_INTERVAL_MS,
            lifetime.signal
          );
          if (closed || lifetime.signal.aborted) return;
          if (nextVersion === observedVersion) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          }
          // If a notification arrived, resolving without a chunk leaves the
          // desired size positive and immediately schedules the next pull.
        } catch (error) {
          if (closed || lifetime.signal.aborted) return;
          retryAfter = Date.now() + ERROR_RETRY_MS;
          controller.enqueue(
            encoder.encode(
              `event: stream-error\ndata: ${JSON.stringify({
                message: error instanceof Error ? error.message : String(error),
              })}\n\n`
            )
          );
        }
      },

      cancel() {
        if (closed) return;
        closed = true;
        lifetime.abort();
        cleanup();
      },
    },
    { highWaterMark: 1 }
  );
};
