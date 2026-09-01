import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openbot/contracts";
import {
  mergeThreadTrayPin,
  THREAD_TRAY_PIN_MAX_MESSAGES,
  THREAD_TRAY_PIN_MAX_RETAINED_BYTES,
} from "../src/renderer/lib/thread-pin";

const message = (sequence: number, content = `message ${sequence}`): ChannelMessageView => ({
  id: `message-${sequence}`,
  sequence: String(sequence),
  channelId: "channel-1",
  sender: "agent",
  senderBotId: "bot-1",
  sourceRunId: null,
  content,
  metadata: {},
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
});

describe("bounded open-thread pins", () => {
  test("merges authoritative objects over pinned copies and preserves the latest submit ID", () => {
    const root = message(1);
    const initial = mergeThreadTrayPin({ root, replies: [message(2), message(3)] });
    const updated = { ...message(3), content: "authoritative update" };
    const merged = mergeThreadTrayPin({
      previous: initial,
      root,
      replies: [updated, message(4)],
    });

    expect(merged.replies.map(({ id }) => id)).toEqual(["message-2", "message-3", "message-4"]);
    expect(merged.replies.find(({ id }) => id === updated.id)).toBe(updated);
    expect(merged.latestReplyId).toBe("message-4");
  });

  test("caps pinned payload while keeping a separate latest-reply identity and truncation signal", () => {
    const root = message(1);
    const replies = Array.from({ length: THREAD_TRAY_PIN_MAX_MESSAGES + 20 }, (_, index) =>
      message(index + 2, "x".repeat(8_000))
    );
    const pin = mergeThreadTrayPin({ root, replies });

    expect(pin.replies.length + 1).toBeLessThanOrEqual(THREAD_TRAY_PIN_MAX_MESSAGES);
    expect(pin.retainedBytes).toBeLessThanOrEqual(THREAD_TRAY_PIN_MAX_RETAINED_BYTES);
    expect(pin.latestReplyId).toBe(replies.at(-1)?.id);
    expect(pin.truncated).toBe(true);
  });
});
