import type { ComputerEvent } from "@openteam/contracts";

/**
 * Converts runtime events to NDJSON one pull at a time. The previous async
 * start loop drained the iterable into ReadableStream's queue regardless of
 * socket/worker backpressure.
 */
export const computerEventStream = (
  events: AsyncIterable<ComputerEvent>,
  encoder = new TextEncoder()
): ReadableStream<Uint8Array> => {
  const iterator = events[Symbol.asyncIterator]();
  let finished = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (finished) return;
        try {
          const result = await iterator.next();
          if (result.done) {
            finished = true;
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(result.value)}\n`));
        } catch (error) {
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
        }
      },

      async cancel() {
        finished = true;
        await iterator.return?.();
      },
    },
    { highWaterMark: 1 }
  );
};
