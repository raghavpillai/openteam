import { expect, test } from "bun:test";
import { consumeComputerEvents } from "../src/computer-events";
import { computerEventStream } from "../../computer/src/computer-event-stream";

const event = { type: "turn.completed", turnId: "run-test", status: "completed" };
const encoder = new TextEncoder();

test("a projection failure cancels the still-live upstream stream", async () => {
  let active = true;
  let applied = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); },
    cancel() { active = false; },
  });
  const failure = new Error("database storage exhausted");
  await expect(consumeComputerEvents(body, async () => { applied++; throw failure; }, () => {})).rejects.toBe(failure);
  expect(active).toBe(false);
  expect(applied).toBe(1);
});

test("malformed runtime data also cancels the turn", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode("not JSON\n")); },
    cancel() { cancelled = true; },
  });
  await expect(consumeComputerEvents(body, async () => {}, () => {})).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("normal split chunks, heartbeats and a final line without newline are retained", async () => {
  const raw = JSON.stringify(event);
  const seen: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of ["\n", raw.slice(0, 11), raw.slice(11)]) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  await consumeComputerEvents(body, async (value) => { seen.push(value); }, () => {});
  expect(seen).toEqual([event]);
});

test("cleanup failure does not replace the original projection error", async () => {
  const failure = new Error("projection failed");
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); },
    cancel() { throw new Error("transport failed"); },
  });
  await expect(consumeComputerEvents(body, async () => { throw failure; }, () => {})).rejects.toBe(failure);
});

test("projection failure over HTTP releases the computer turn for the next request", async () => {
  let active = false;
  let release!: () => void;
  const stopped = Promise.withResolvers<void>();
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      if (active) return new Response("already active", { status: 409 });
      active = true;
      return new Response(computerEventStream((async function* () {
        yield { type: "turn.started", turnId: "live-test" };
        await waiting;
      })(), undefined, { onCancel: () => { active = false; release(); stopped.resolve(); } }));
    },
  });
  try {
    const abort = new AbortController();
    const response = await fetch(server.url, { signal: abort.signal });
    await expect(consumeComputerEvents(response.body!, async () => { throw new Error("disk full"); }, () => abort.abort())).rejects.toThrow("disk full");
    await Promise.race([stopped.promise, Bun.sleep(2000).then(() => { throw new Error("turn was orphaned"); })]);
    expect(active).toBe(false);
    const next = await fetch(server.url);
    expect(next.status).toBe(200);
    await next.body!.cancel();
  } finally { release(); server.stop(true); }
});
