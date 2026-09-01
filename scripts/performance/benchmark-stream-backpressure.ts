import type { ComputerEvent } from "@openbot/contracts";
import { AsyncQueue } from "../../apps/computer/src/async-queue";
import { ComputerEventQueue } from "../../apps/computer/src/computer-event-queue";
import { computerEventStream } from "../../apps/computer/src/computer-event-stream";
import { eventStream } from "../../apps/server/src/event-stream";

const itemCount = 50_000;
const samples = 5;

class LegacyShiftQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];

  push(value: T) {
    this.values.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        return value === undefined ? { value: undefined, done: true } : { value, done: false };
      },
    };
  }
}

const drainTime = async (queue: AsyncIterable<number>) => {
  const startedAt = performance.now();
  let count = 0;
  for await (const _value of queue) count += 1;
  if (count !== itemCount) throw new Error(`Expected ${itemCount} queue items, received ${count}`);
  return performance.now() - startedAt;
};

const legacyQueueMs: number[] = [];
const boundedQueueMs: number[] = [];
for (let sample = 0; sample < samples; sample += 1) {
  const legacy = new LegacyShiftQueue<number>();
  const bounded = new AsyncQueue<number>();
  for (let index = 0; index < itemCount; index += 1) {
    legacy.push(index);
    bounded.push(index);
  }
  bounded.end();
  legacyQueueMs.push(await drainTime(legacy));
  boundedQueueMs.push(await drainTime(bounded));
}

const deltaFragments = 10_000;
const eventQueue = new ComputerEventQueue();
for (let index = 0; index < deltaFragments; index += 1) {
  eventQueue.push({ type: "agent.delta", turnId: "run", itemId: "assistant", delta: "x" });
}
eventQueue.push({ type: "item.completed", turnId: "run", item: { id: "assistant" } });
eventQueue.end();
let coalescedDeltaEvents = 0;
let coalescedCharacters = 0;
for await (const event of eventQueue) {
  if (event.type !== "agent.delta") continue;
  coalescedDeltaEvents += 1;
  coalescedCharacters += event.delta.length;
}

const backlogEvents = 100_000;
let pullCalls = 0;
const source: AsyncIterable<ComputerEvent> = {
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        pullCalls += 1;
        return pullCalls > backlogEvents
          ? { value: undefined, done: true }
          : {
              value: { type: "turn.started", turnId: String(pullCalls) },
              done: false,
            };
      },
    };
  },
};
const stream = computerEventStream(source);
await new Promise((resolve) => setTimeout(resolve, 0));
const stalledPeerPullCalls = pullCalls;
await stream.cancel();

let sseWindowCalls = 0;
const sseLimits: number[] = [];
const sse = eventStream(
  {
    eventVersion: 0,
    eventWindowAfter: async (_cursor, limit) => {
      sseWindowCalls += 1;
      sseLimits.push(limit);
      return {
        oldest: 1n,
        latest: BigInt(backlogEvents),
        cursorExpired: false,
        cursorAhead: false,
        events: Array.from({ length: limit }, (_, index) => ({
          sequence: String(index + 1),
          topic: "message.created",
          entityId: String(index + 1),
          payload: {},
          createdAt: "2026-08-31T00:00:00.000Z",
        })),
      };
    },
    waitForEvent: async (version) => version,
  },
  0n,
  new AbortController().signal
);
await new Promise((resolve) => setTimeout(resolve, 0));
const sseCallsBeforeRead = sseWindowCalls;
const sseReader = sse.getReader();
await sseReader.read();
await new Promise((resolve) => setTimeout(resolve, 0));
const sseCallsWithStalledEventChunk = sseWindowCalls;
await sseReader.cancel();

const median = (values: readonly number[]) =>
  [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

const output = JSON.stringify(
  {
    measuredAt: new Date().toISOString(),
    queue: {
      items: itemCount,
      samples,
      legacyArrayShiftMs: legacyQueueMs,
      legacyMedianMs: median(legacyQueueMs),
      amortizedQueueMs: boundedQueueMs,
      amortizedMedianMs: median(boundedQueueMs),
    },
    tokenProjection: {
      inputFragments: deltaFragments,
      outputCharacters: coalescedCharacters,
      legacyDeltaEvents: deltaFragments,
      coalescedDeltaEvents,
      legacyHotPathDatabaseStatements: deltaFragments * 4,
      currentHotPathDatabaseStatements: coalescedDeltaEvents,
    },
    stalledPeer: {
      retainedBacklogEvents: backlogEvents,
      legacyStartLoopPullCalls: backlogEvents + 1,
      pullDrivenBufferedCalls: stalledPeerPullCalls,
    },
    stalledSsePeer: {
      retainedBacklogEvents: backlogEvents,
      legacyBatchSize: 500,
      legacyWindowQueries: Math.ceil(backlogEvents / 500),
      legacyQueuedProductEvents: backlogEvents,
      windowQueriesBeforeConnectedChunkRead: sseCallsBeforeRead,
      windowQueriesAfterConnectedChunkRead: sseCallsWithStalledEventChunk,
      currentWindowLimits: sseLimits,
      currentQueuedProductEvents: sseLimits[0] ?? 0,
    },
  },
  null,
  2
);
if (process.env.OPENBOT_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENBOT_AUDIT_OUTPUT, `${output}\n`);
}
console.log(output);
