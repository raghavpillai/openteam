import { describe, expect, test } from "bun:test";
import { type EventStreamSource, eventStream, SSE_EVENT_BATCH_SIZE } from "../src/event-stream";

const decoder = new TextDecoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const event = (sequence: number) => ({
  sequence: String(sequence),
  topic: "message.created",
  entityId: `message-${sequence}`,
  payload: { sequence },
  createdAt: "2026-08-31T00:00:00.000Z",
});

describe("pull-driven event stream", () => {
  test("does not query events until the connected chunk is consumed", async () => {
    let calls = 0;
    const source: EventStreamSource = {
      eventVersion: 0,
      eventWindowAfter: async () => {
        calls += 1;
        return {
          oldest: null,
          latest: null,
          cursorExpired: false,
          cursorAhead: false,
          events: [],
        };
      },
      waitForEvent: async (version) => version,
    };
    const request = new AbortController();
    const stream = eventStream(source, 0n, request.signal);

    await tick();
    expect(calls).toBe(0);
    await stream.cancel();
  });

  test("a slow consumer buffers only one bounded database window", async () => {
    const limits: number[] = [];
    const source: EventStreamSource = {
      eventVersion: 0,
      eventWindowAfter: async (_cursor, limit) => {
        limits.push(limit);
        return {
          oldest: 1n,
          latest: 1_000n,
          cursorExpired: false,
          cursorAhead: false,
          events: Array.from({ length: limit }, (_, index) => event(index + 1)),
        };
      },
      waitForEvent: async (version) => version,
    };
    const reader = eventStream(source, 0n, new AbortController().signal).getReader();

    const connected = await reader.read();
    expect(decoder.decode(connected.value)).toBe(": connected\n\n");
    await tick();
    expect(limits).toEqual([SSE_EVENT_BATCH_SIZE]);

    // Leave the 64-event chunk unread: no second query is allowed to run.
    await tick();
    expect(limits).toEqual([SSE_EVENT_BATCH_SIZE]);
    await reader.cancel();
  });

  test("fast readers receive every event in order across bounded windows", async () => {
    const allEvents = Array.from({ length: 130 }, (_, index) => event(index + 1));
    const limits: number[] = [];
    const source: EventStreamSource = {
      eventVersion: 0,
      eventWindowAfter: async (cursor, limit) => {
        limits.push(limit);
        const events = allEvents
          .filter((candidate) => BigInt(candidate.sequence) > cursor)
          .slice(0, limit);
        return {
          oldest: 1n,
          latest: 130n,
          cursorExpired: false,
          cursorAhead: false,
          events,
        };
      },
      waitForEvent: (_version, _timeout, signal) =>
        new Promise((resolve) =>
          signal?.addEventListener("abort", () => resolve(0), { once: true })
        ),
    };
    const reader = eventStream(source, 0n, new AbortController().signal).getReader();
    await reader.read();

    const sequences: number[] = [];
    while (sequences.length < allEvents.length) {
      const chunk = await reader.read();
      const text = decoder.decode(chunk.value);
      for (const match of text.matchAll(/^id: (\d+)$/gm)) sequences.push(Number(match[1]));
    }
    await reader.cancel();

    expect(sequences).toEqual(Array.from({ length: 130 }, (_, index) => index + 1));
    expect(limits.every((limit) => limit === SSE_EVENT_BATCH_SIZE)).toBe(true);
  });

  test("invalid cursors emit one snapshot.required product event", async () => {
    const source: EventStreamSource = {
      eventVersion: 0,
      eventWindowAfter: async () => ({
        oldest: 10n,
        latest: 20n,
        cursorExpired: true,
        cursorAhead: false,
        events: [],
      }),
      waitForEvent: async (version) => version,
    };
    const reader = eventStream(source, 2n, new AbortController().signal).getReader();
    await reader.read();
    const chunk = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(chunk).toContain("id: 20\n");
    expect(chunk).toContain('"topic":"snapshot.required"');
    expect(chunk).toContain('"reason":"cursor_expired"');
  });

  test("cancel aborts a pending event wait", async () => {
    let waitSignal: AbortSignal | undefined;
    const source: EventStreamSource = {
      eventVersion: 0,
      eventWindowAfter: async () => ({
        oldest: null,
        latest: null,
        cursorExpired: false,
        cursorAhead: false,
        events: [],
      }),
      waitForEvent: (_version, _timeout, signal) => {
        waitSignal = signal;
        return new Promise((resolve) =>
          signal?.addEventListener("abort", () => resolve(0), { once: true })
        );
      },
    };
    const reader = eventStream(source, 0n, new AbortController().signal).getReader();
    await reader.read();
    const pendingRead = reader.read();
    while (!waitSignal) await tick();
    await reader.cancel();
    await pendingRead;

    expect(waitSignal?.aborted).toBe(true);
  });
});
