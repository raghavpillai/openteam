import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openbot/contracts";
import {
  boundMessageWindow,
  boundMessageWindowAroundViewport,
  latestRefreshOverlap,
  messageRetainedByteSize,
} from "../src/message-window";

const message = (
  sequence: number,
  overrides: Partial<ChannelMessageView> = {}
): ChannelMessageView => ({
  id: `message-${sequence}`,
  sequence: String(sequence),
  channelId: "channel-1",
  sender: "agent",
  senderBotId: "bot-1",
  sourceRunId: null,
  content: `Message ${sequence}`,
  metadata: {},
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
  ...overrides,
});

const messages = (count: number, start = 1): ChannelMessageView[] =>
  Array.from({ length: count }, (_, index) => message(start + index));

const generousBytes = 100 * 1024 * 1024;

describe("bounded message windows", () => {
  test.each([100, 500])("retains all %i messages at or below the count cap", (count) => {
    const result = boundMessageWindow(messages(count), {
      maxMessages: 500,
      maxBytes: generousBytes,
      retain: "newest",
    });

    expect(result.messages).toHaveLength(count);
    expect(result.eviction).toEqual({ older: null, newer: null });
    expect(result.gaps).toEqual({ older: false, newer: false });
    expect(result.retainedBytes).toBe(result.primaryBytes);
  });

  test("keeps the newest 500 of 1,000 messages and reports an older gap", () => {
    const result = boundMessageWindow(messages(1_000), {
      maxMessages: 500,
      maxBytes: generousBytes,
      retain: "newest",
    });

    expect(result.messages).toHaveLength(500);
    expect(result.messages[0]?.id).toBe("message-501");
    expect(result.messages.at(-1)?.id).toBe("message-1000");
    expect(result.eviction).toEqual({
      older: {
        count: 500,
        adjacentEvictedMessageId: "message-500",
        boundaryRetainedMessageId: "message-501",
      },
      newer: null,
    });
    expect(result.gaps).toEqual({ older: true, newer: false });
  });

  test("can retain the oldest edge and carries pre-existing gaps forward", () => {
    const result = boundMessageWindow(messages(1_000), {
      maxMessages: 500,
      maxBytes: generousBytes,
      retain: "oldest",
      existingGaps: { older: true },
    });

    expect(result.messages[0]?.id).toBe("message-1");
    expect(result.messages.at(-1)?.id).toBe("message-500");
    expect(result.eviction.newer).toEqual({
      count: 500,
      adjacentEvictedMessageId: "message-501",
      boundaryRetainedMessageId: "message-500",
    });
    expect(result.gaps).toEqual({ older: true, newer: true });
  });

  test("uses the total retained byte budget and keeps an indivisible rich message", () => {
    const rich = message(3, { content: "rich".repeat(10_000) });
    const result = boundMessageWindow([message(1), message(2), rich], {
      maxMessages: 10,
      maxBytes: 1_000,
      retain: "newest",
    });

    expect(result.messages).toEqual([rich]);
    expect(result.retainedBytes).toBe(messageRetainedByteSize(rich));
    expect(result.softExcess.bytes).toBe(result.retainedBytes - 1_000);
    expect(result.softExcess).toMatchObject({ messages: 0, protected: false, oversized: true });
    expect(result.gaps.older).toBe(true);
  });

  test("stops at an exact byte boundary before the count cap", () => {
    const values = messages(5);
    const maxBytes = values
      .slice(3)
      .reduce((total, value) => total + messageRetainedByteSize(value), 0);
    const result = boundMessageWindow(values, {
      maxMessages: 5,
      maxBytes,
      retain: "newest",
    });

    expect(result.messages.map(({ id }) => id)).toEqual(["message-4", "message-5"]);
    expect(result.retainedBytes).toBe(maxBytes);
    expect(result.softExcess).toEqual({
      messages: 0,
      bytes: 0,
      protected: false,
      oversized: false,
    });
    expect(result.eviction.older?.count).toBe(3);
  });

  test("classifies a single indivisible message as oversized without needing a following row", () => {
    const rich = message(1, { content: "rich".repeat(10_000) });
    const result = boundMessageWindow([rich], {
      maxMessages: 10,
      maxBytes: 1_000,
      retain: "newest",
    });

    expect(result.messages).toEqual([rich]);
    expect(result.softExcess).toMatchObject({ protected: false, oversized: true });
  });

  test("does not blame an unrelated missing protected ID for an oversized message", () => {
    const rich = message(1, { content: "rich".repeat(10_000) });
    const result = boundMessageWindow([rich], {
      maxMessages: 10,
      maxBytes: 1_000,
      retain: "newest",
      protectedIds: new Set(["not-loaded"]),
    });

    expect(result.missingProtectedIds).toEqual(["not-loaded"]);
    expect(result.softExcess).toMatchObject({ protected: false, oversized: true });
  });

  test("extends a contiguous window rather than evicting a protected visible anchor", () => {
    const result = boundMessageWindow(messages(1_000), {
      maxMessages: 500,
      maxBytes: generousBytes,
      retain: "newest",
      protectedIds: new Set(["message-450", "message-999"]),
    });

    expect(result.messages).toHaveLength(551);
    expect(result.messages[0]?.id).toBe("message-450");
    expect(result.messages.at(-1)?.id).toBe("message-1000");
    expect(result.messages.some(({ id }) => id === "message-450")).toBe(true);
    expect(result.softExcess).toEqual({
      messages: 51,
      bytes: 0,
      protected: true,
      oversized: false,
    });
    expect(result.eviction.older?.count).toBe(449);
  });

  test("symmetrically preserves a protected target while retaining the oldest edge", () => {
    const result = boundMessageWindow(messages(1_000), {
      maxMessages: 500,
      maxBytes: generousBytes,
      retain: "oldest",
      protectedIds: new Set(["message-550"]),
    });

    expect(result.messages).toHaveLength(550);
    expect(result.messages[0]?.id).toBe("message-1");
    expect(result.messages.at(-1)?.id).toBe("message-550");
    expect(result.softExcess).toEqual({
      messages: 50,
      bytes: 0,
      protected: true,
      oversized: false,
    });
    expect(result.eviction.newer?.count).toBe(450);
  });

  test("pivots around the visible span without retaining a rich edge-to-anchor range", () => {
    const values = messages(600, 1).map((candidate, index) =>
      index < 100 ? { ...candidate, content: "rich".repeat(7_500) } : candidate
    );
    const result = boundMessageWindowAroundViewport(values, {
      maxMessages: 500,
      maxBytes: 2 * 1024 * 1024,
      fill: "older-first",
      viewportMessageIds: new Set(["message-101"]),
    });

    expect(result.messages.some(({ id }) => id === "message-101")).toBe(true);
    expect(result.messages[0]?.id).not.toBe("message-1");
    expect(result.retainedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.softExcess.protected).toBe(false);
    expect(result.gaps).toEqual({ older: true, newer: true });
  });

  test("fills the requested side of a visible pivot before the opposite side", () => {
    const older = boundMessageWindowAroundViewport(messages(10), {
      maxMessages: 5,
      maxBytes: generousBytes,
      fill: "older-first",
      viewportMessageIds: new Set(["message-5"]),
    });
    const newer = boundMessageWindowAroundViewport(messages(10), {
      maxMessages: 5,
      maxBytes: generousBytes,
      fill: "newer-first",
      viewportMessageIds: new Set(["message-5"]),
    });

    expect(older.messages.map(({ id }) => id)).toEqual([
      "message-1",
      "message-2",
      "message-3",
      "message-4",
      "message-5",
    ]);
    expect(newer.messages.map(({ id }) => id)).toEqual([
      "message-5",
      "message-6",
      "message-7",
      "message-8",
      "message-9",
    ]);
  });

  test("allows only the mandatory visible span to create a protected byte excess", () => {
    const rich = messages(5).map((candidate) => ({
      ...candidate,
      content: "x".repeat(1_000),
    }));
    const spanBytes = rich
      .slice(1, 4)
      .reduce((total, candidate) => total + messageRetainedByteSize(candidate), 0);
    const result = boundMessageWindowAroundViewport(rich, {
      maxMessages: 5,
      maxBytes: spanBytes - 1,
      fill: "older-first",
      viewportMessageIds: new Set(["message-2", "message-4"]),
    });

    expect(result.messages.map(({ id }) => id)).toEqual(["message-2", "message-3", "message-4"]);
    expect(result.retainedBytes).toBe(spanBytes);
    expect(result.softExcess).toMatchObject({ protected: true, oversized: false });
  });

  test("moves transitive reply ancestors outside the primary cap into thread context", () => {
    const root = message(1);
    const reply = message(2, { metadata: { branched: true, replyTo: root.id } });
    const nested = message(3, { metadata: { branched: true, replyTo: reply.id } });
    const result = boundMessageWindow([nested], {
      maxMessages: 1,
      maxBytes: generousBytes,
      retain: "newest",
      threadContext: [reply, root],
    });

    expect(result.messages.map(({ id }) => id)).toEqual([nested.id]);
    expect(result.threadContext.map(({ id }) => id)).toEqual([root.id, reply.id]);
    expect(result.retainedBytes).toBe(
      messageRetainedByteSize(root) +
        messageRetainedByteSize(reply) +
        messageRetainedByteSize(nested)
    );
    expect(result.missingAncestorIds).toEqual([]);
  });

  test("preserves a root evicted from the primary lane when its reply remains", () => {
    const root = message(1);
    const reply = message(2, { metadata: { branched: true, replyTo: root.id } });
    const result = boundMessageWindow([root, reply, message(3)], {
      maxMessages: 2,
      maxBytes: generousBytes,
      retain: "newest",
    });

    expect(result.messages.map(({ id }) => id)).toEqual([reply.id, "message-3"]);
    expect(result.threadContext.map(({ id }) => id)).toEqual([root.id]);
  });

  test("retains protected context targets and reports unavailable protected or ancestor IDs", () => {
    const target = message(50, { metadata: { replyTo: "missing-root" } });
    const result = boundMessageWindow([message(100)], {
      maxMessages: 1,
      maxBytes: generousBytes,
      retain: "newest",
      protectedIds: new Set([target.id, "not-loaded"]),
      threadContext: [target],
    });

    expect(result.threadContext).toEqual([target]);
    expect(result.missingProtectedIds).toEqual(["not-loaded"]);
    expect(result.missingAncestorIds).toEqual(["missing-root"]);
  });

  test("deduplicates and restores chronological sequence order", () => {
    const duplicate = message(2, { content: "latest copy" });
    const result = boundMessageWindow(
      [message(10), message(2, { content: "old copy" }), message(1), duplicate],
      {
        maxMessages: 10,
        maxBytes: generousBytes,
        retain: "newest",
      }
    );

    expect(result.messages.map(({ id }) => id)).toEqual(["message-1", "message-2", "message-10"]);
    expect(result.messages[1]?.content).toBe("latest copy");
    expect(new Set(result.messages.map(({ id }) => id)).size).toBe(result.messages.length);
  });

  test("rejects invalid count and byte limits", () => {
    expect(() => boundMessageWindow([], { maxMessages: 0, maxBytes: 1, retain: "newest" })).toThrow(
      RangeError
    );
    expect(() =>
      boundMessageWindow([], {
        maxMessages: 1,
        maxBytes: Number.POSITIVE_INFINITY,
        retain: "newest",
      })
    ).toThrow(RangeError);
  });
});

describe("latest refresh overlap", () => {
  test("uses IDs to classify overlap even when sequence values are globally sparse", () => {
    const retained = [message(1), message(10), message(100)];
    const refresh = [message(100), message(1_000), message(10_000)];

    expect(latestRefreshOverlap(retained, refresh)).toEqual({
      disposition: "merge",
      overlaps: true,
      requiresReset: false,
      overlapIds: ["message-100"],
      retainedNewestMessageId: "message-100",
      refreshOldestMessageId: "message-100",
      refreshNewestMessageId: "message-10000",
    });
  });

  test("requires reset for a non-empty latest page with no retained ID", () => {
    const result = latestRefreshOverlap(messages(100), messages(100, 151));
    expect(result.disposition).toBe("reset");
    expect(result.overlaps).toBe(false);
    expect(result.requiresReset).toBe(true);
    expect(result.overlapIds).toEqual([]);
  });

  test("distinguishes initialization and an empty refresh", () => {
    expect(latestRefreshOverlap([], [message(1)])).toMatchObject({
      disposition: "initialize",
      requiresReset: false,
    });
    expect(latestRefreshOverlap([message(1)], [])).toMatchObject({
      disposition: "empty",
      requiresReset: false,
    });
  });
});
