import type { ComputerEvent } from "@openteam/contracts";

/**
 * Converts runtime events to NDJSON one pull at a time. The previous async
 * start loop drained the iterable into ReadableStream's queue regardless of
 * socket/worker backpressure.
 */
export const computerEventStream = (
  events: AsyncIterable<ComputerEvent>,
  encoder = new TextEncoder(),
  options: { heartbeatMs?: number; onCancel?: () => void | Promise<void> } = {}
): ReadableStream<Uint8Array> => {
  const iterator = events[Symbol.asyncIterator]();
  let finished = false;
  let pending: Promise<IteratorResult<ComputerEvent>> | undefined;
  const heartbeat = Symbol("heartbeat");

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (finished) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Retain the same read across heartbeats: never advance or buffer the
          // producer while a foreground child or approval is still pending.
          pending ??= iterator.next();
          const result = await Promise.race([
            pending,
            new Promise<typeof heartbeat>((resolve) => {
              timer = setTimeout(() => resolve(heartbeat), options.heartbeatMs ?? 15_000);
            }),
          ]);
          if (finished) return;
          if (result === heartbeat) {
            // Blank NDJSON lines are transport keepalives, not agent events.
            controller.enqueue(encoder.encode("\n"));
            return;
          }
          pending = undefined;
          if (result.done) {
            finished = true;
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(result.value)}\n`));
        } catch (error) {
          if (finished) return;
          finished = true;
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type: "runtime.error",
                message: error instanceof Error ? error.message : String(error),
                retrying: false,
              })}\n`
            )
          );
          controller.close();
        } finally {
          clearTimeout(timer);
        }
      },

      async cancel() {
        finished = true;
        try {
          await options.onCancel?.();
        } finally {
          await iterator.return?.();
        }
      },
    },
    { highWaterMark: 1 }
  );
};
