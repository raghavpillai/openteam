import { describe, expect, test } from "bun:test";
import type { ComputerEvent } from "@openteam/contracts";
import { ComputerEventQueue } from "../src/computer-event-queue";
import { computerEventStream } from "../src/computer-event-stream";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("computer event stream", () => {
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
});
