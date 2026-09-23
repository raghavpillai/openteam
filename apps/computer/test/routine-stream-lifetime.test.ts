import { expect, test } from "bun:test";
import { computerEventStream } from "../src/computer-event-stream";

test("an aborted HTTP consumer releases the runtime waiting on an approval", async () => {
  let release!: () => void;
  let cancelled = 0;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        computerEventStream(
          (async function* () {
            yield { type: "turn.started", turnId: "disconnect" } as any;
            await waiting;
          })(),
          undefined,
          {
            onCancel: () => {
              cancelled++;
              release();
            },
          }
        )
      );
    },
  });
  const abort = new AbortController();
  try {
    const response = await fetch(server.url, { signal: abort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.read().catch(() => {});
    for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10);
    expect(cancelled).toBe(1);
  } finally {
    release();
    server.stop(true);
  }
});

test("quiet foreground tasks keep their HTTP event stream alive", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 1,
    fetch() {
      return new Response(
        computerEventStream(
          (async function* () {
            yield { type: "turn.started", turnId: "quiet-routine" } as any;
            await Bun.sleep(2200);
            yield { type: "turn.completed", turnId: "quiet-routine", status: "completed" } as any;
          })(),
          undefined,
          { heartbeatMs: 100 }
        ),
        { headers: { "content-type": "application/x-ndjson" } }
      );
    },
  });
  try {
    const response = await fetch(server.url);
    const body = await response.text();
    expect(body).toContain("\n\n");
    const events = body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
  } finally {
    server.stop(true);
  }
}, 10000);

test("disconnect cancels the owning runtime before returning its iterator", async () => {
  const order: string[] = [];
  const stream = computerEventStream(
    {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return {
              done: false as const,
              value: { type: "turn.started", turnId: "cancel" } as any,
            };
          },
          async return() {
            order.push("iterator");
            return { done: true as const, value: undefined };
          },
        };
      },
    },
    undefined,
    {
      onCancel: async () => {
        order.push("runtime");
      },
    }
  );
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel();
  expect(order).toEqual(["runtime", "iterator"]);
});
