import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import {
  boundMessageWindow,
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

});
