import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import { collapseA2ATimeline } from "@openteam/product-core/messages";

const exchangeMessage = (
  id: string,
  peerId: string,
  direction: "incoming" | "outgoing",
  createdAt: string
): ChannelMessageView => ({
  id,
  sequence: id.replace(/\D/g, "") || "1",
  channelId: "source-channel",
  sender: "agent",
  senderBotId: "source-bot",
  sourceRunId: null,
  content: id,
  metadata:
    direction === "incoming"
      ? { fromAgent: { id: peerId, name: `Peer ${peerId}` } }
      : { toAgent: { id: peerId, name: `Peer ${peerId}`, kind: "agent" } },
  createdAt,
});

describe("native A2A parity projection", () => {
  test("collapses a contiguous exchange with one peer and preserves every message", () => {
    const first = exchangeMessage("message-1", "peer-1", "outgoing", "2026-01-01T00:00:00.000Z");
    const second = exchangeMessage("message-2", "peer-1", "incoming", "2026-01-01T00:00:10.000Z");
    const timeline = collapseA2ATimeline([first, second], (message) => message);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      type: "a2a",
      peerId: "peer-1",
      entries: [first, second],
    });
  });

  test("keeps different peers and idle-gap exchanges independently reachable", () => {
    const timeline = collapseA2ATimeline(
      [
        exchangeMessage("message-1", "peer-1", "outgoing", "2026-01-01T00:00:00.000Z"),
        exchangeMessage("message-2", "peer-2", "incoming", "2026-01-01T00:00:05.000Z"),
        exchangeMessage("message-3", "peer-1", "incoming", "2026-01-01T01:00:00.000Z"),
      ],
      (message) => message
    );

    expect(timeline).toHaveLength(3);
    expect(timeline.map((entry) => ("type" in entry ? entry.peerId : null))).toEqual([
      "peer-1",
      "peer-2",
      "peer-1",
    ]);
  });
});
