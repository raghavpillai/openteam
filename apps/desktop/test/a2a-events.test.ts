import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import { a2aProjectionFor, collapseA2ATimeline } from "../src/renderer/lib/a2a-events";

const stamp = "2026-08-27T18:16:22.238Z";

const projected = (
  id: string,
  direction: "incoming" | "outgoing",
  seconds: number,
  peer = { id: "peer-1", name: "Parity Probe v3" }
): ChannelMessageView => ({
  id,
  sequence: id,
  channelId: "home-chat",
  sender: direction === "incoming" ? "user" : "agent",
  senderBotId: direction === "incoming" ? "peer-1" : "agent-1",
  sourceRunId: null,
  content: direction === "incoming" ? "ACK" : "Ping",
  metadata: {
    [direction === "incoming" ? "fromAgent" : "toAgent"]: {
      ...peer,
      ...(direction === "outgoing" ? { kind: "agent" } : {}),
    },
  },
  createdAt: new Date(Date.parse(stamp) + seconds * 1_000).toISOString(),
});

const entry = (message: ChannelMessageView) => ({
  type: "message" as const,
  id: message.id,
  createdAt: message.createdAt,
  message,
});

describe("A2A timeline events", () => {
  test("reads the peer from the direction-specific mirrored row", () => {
    expect(a2aProjectionFor(projected("1", "outgoing", 0))).toEqual({
      direction: "outgoing",
      peerId: "peer-1",
      peerName: "Parity Probe v3",
    });
    expect(a2aProjectionFor(projected("2", "incoming", 6))).toEqual({
      direction: "incoming",
      peerId: "peer-1",
      peerName: "Parity Probe v3",
    });
  });

  test("collapses a live ping and ACK into one compact peer event", () => {
    const outbound = entry(projected("1", "outgoing", 0));
    const inbound = entry(projected("2", "incoming", 6));
    const collapsed = collapseA2ATimeline([outbound, inbound], (candidate) => candidate.message);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      type: "a2a",
      id: "a2a:1",
      peerId: "peer-1",
      peerName: "Parity Probe v3",
      entries: [outbound, inbound],
    });
  });

  test("keeps a visible status update between separate nearby A2A events", () => {
    const first = entry(projected("1", "outgoing", 0));
    const ordinary = {
      type: "task" as const,
      id: "task-1",
      createdAt: new Date(Date.parse(stamp) + 2_000).toISOString(),
    };
    const afterActivity = entry(projected("2", "incoming", 6));
    const collapsed = collapseA2ATimeline([first, ordinary, afterActivity], (candidate) =>
      "message" in candidate ? candidate.message : null
    );
    expect(collapsed.map((candidate) => candidate.type)).toEqual(["a2a", "task", "a2a"]);
    expect(collapsed[0]).toMatchObject({ entries: [first] });
    expect(collapsed[2]).toMatchObject({ entries: [afterActivity] });
  });

  test("does not merge different peers or idle gaps", () => {
    const first = entry(projected("1", "outgoing", 0));
    const nearbyReply = entry(projected("2", "incoming", 6));
    const anotherPeer = entry(
      projected("3", "outgoing", 8, { id: "peer-2", name: "Another Agent" })
    );
    const muchLater = entry(projected("4", "incoming", 1_910));
    const collapsed = collapseA2ATimeline(
      [first, nearbyReply, anotherPeer, muchLater],
      (candidate) => ("message" in candidate ? candidate.message : null)
    );
    expect(collapsed.map((candidate) => candidate.type)).toEqual(["a2a", "a2a", "a2a"]);
  });
});
