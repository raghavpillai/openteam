import { describe, expect, test } from "bun:test";
import type { ComputerEvent } from "@openteam/contracts";
import { AsyncQueue } from "../src/async-queue";
import {
  AGENT_DELTA_FLUSH_INTERVAL_MS,
  AGENT_DELTA_MAX_CHARS,
  ComputerEventQueue,
} from "../src/computer-event-queue";
import { computerEventStream } from "../src/computer-event-stream";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("computer stream backpressure", () => {
  test("AsyncQueue preserves a large buffered sequence with amortized dequeue", async () => {
    const queue = new AsyncQueue<number>();
    for (let index = 0; index < 20_000; index += 1) queue.push(index);
    queue.end();

    const values: number[] = [];
    for await (const value of queue) values.push(value);
    expect(values).toHaveLength(20_000);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(19_999);
  });

  test("coalesces adjacent token fragments and flushes before a boundary", async () => {
    const queue = new ComputerEventQueue();
    queue.push({ type: "agent.delta", turnId: "run", itemId: "item", delta: "butter" });
    queue.push({ type: "agent.delta", turnId: "run", itemId: "item", delta: "y" });
    queue.push({ type: "item.completed", turnId: "run", item: { id: "item" } });
    queue.end();

    const events: ComputerEvent[] = [];
    for await (const event of queue) events.push(event);
    expect(events).toEqual([
      { type: "agent.delta", turnId: "run", itemId: "item", delta: "buttery" },
      { type: "item.completed", turnId: "run", item: { id: "item" } },
    ]);
  });

  test("bounds coalescing latency and fragment size", async () => {
    const timed = new ComputerEventQueue();
    const timedIterator = timed[Symbol.asyncIterator]();
    timed.push({ type: "agent.delta", turnId: "run", itemId: "item", delta: "partial" });
    const startedAt = performance.now();
    const timedResult = await timedIterator.next();
    expect(timedResult.value).toMatchObject({ type: "agent.delta", delta: "partial" });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(AGENT_DELTA_FLUSH_INTERVAL_MS - 5);
    timed.end();

    const sized = new ComputerEventQueue();
    const sizedIterator = sized[Symbol.asyncIterator]();
    sized.push({
      type: "agent.delta",
      turnId: "run",
      itemId: "item",
      delta: "x".repeat(AGENT_DELTA_MAX_CHARS),
    });
    expect((await sizedIterator.next()).value).toMatchObject({
      type: "agent.delta",
      delta: "x".repeat(AGENT_DELTA_MAX_CHARS),
    });
    sized.end();
  });

  test("the NDJSON stream pulls only one event ahead of a stalled peer", async () => {
    let nextCalls = 0;
    const events: AsyncIterable<ComputerEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            nextCalls += 1;
            return {
              value: { type: "turn.started", turnId: String(nextCalls) },
              done: false,
            } as IteratorResult<ComputerEvent>;
          },
        };
      },
    };
    const stream = computerEventStream(events);

    await tick();
    expect(nextCalls).toBe(1);
    await tick();
    expect(nextCalls).toBe(1);
    await stream.cancel();
  });

  test("serializes events in order and reports iterator failures", async () => {
    async function* ordered() {
      yield { type: "turn.started", turnId: "run" } as const;
      yield { type: "turn.completed", turnId: "run", status: "completed" } as const;
    }
    const reader = computerEventStream(ordered()).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      '"type":"turn.started"'
    );
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      '"type":"turn.completed"'
    );
    expect((await reader.read()).done).toBe(true);

    async function* failed(): AsyncGenerator<ComputerEvent> {
      throw new Error("stream exploded");
    }
    const failedReader = computerEventStream(failed()).getReader();
    const errorChunk = new TextDecoder().decode((await failedReader.read()).value);
    expect(errorChunk).toContain('"type":"runtime.error"');
    expect(errorChunk).toContain("stream exploded");
    expect((await failedReader.read()).done).toBe(true);
  });
});
