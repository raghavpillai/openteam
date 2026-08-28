import { describe, expect, test } from "bun:test";
import type { ClientSnapshot } from "@openbot/contracts";
import {
  deriveAgentNotifications,
  deriveUnreadChannelIds,
} from "../src/renderer/lib/notifications";

const base = {
  bots: [{ id: "bot", name: "Probe", notificationsEnabled: true }],
  channels: [{ id: "channel", name: "Probe" }],
  channelMessages: [{ id: "before", channelId: "channel", createdAt: "2026-01-01T00:00:00Z" }],
  runs: [],
} as unknown as ClientSnapshot;

describe("Grok-compatible notification transitions", () => {
  test("notifies only on entering needs-input and finishing with a new last message", () => {
    const running = {
      ...base,
      runs: [
        {
          id: "run",
          botId: "bot",
          channelId: "channel",
          status: "running",
          updatedAt: "2026-01-01T00:00:01Z",
        },
      ],
    } as ClientSnapshot;
    const waiting = {
      ...running,
      runs: [{ ...running.runs[0], status: "waiting_approval" }],
    } as ClientSnapshot;
    expect(deriveAgentNotifications(running, waiting).map(({ kind }) => kind)).toEqual([
      "agent-needs-input",
    ]);
    expect(deriveAgentNotifications(waiting, waiting)).toEqual([]);

    const done = {
      ...base,
      channelMessages: [
        ...base.channelMessages,
        { id: "after", channelId: "channel", createdAt: "2026-01-01T00:00:02Z" },
      ],
    } as ClientSnapshot;
    expect(deriveAgentNotifications(running, done).map(({ kind }) => kind)).toEqual(["agent-done"]);
    expect(deriveAgentNotifications(running, base)).toEqual([]);
  });

  test("raises room activity but suppresses peer A2A home rows", () => {
    const current = {
      ...base,
      channels: [
        ...base.channels,
        { id: "room", name: "Testing" },
        { id: "peer-home", name: "Probe" },
      ],
      channelMessages: [
        ...base.channelMessages,
        {
          id: "room-post",
          channelId: "room",
          createdAt: "2026-01-01T00:00:02Z",
          metadata: {
            kind: "send-message",
            author: { id: "bot", name: "Probe" },
          },
        },
        {
          id: "peer-a2a",
          channelId: "peer-home",
          createdAt: "2026-01-01T00:00:03Z",
          metadata: { fromAgent: { id: "peer", name: "Peer" } },
        },
      ],
    } as unknown as ClientSnapshot;
    expect(deriveUnreadChannelIds(base, current, "channel")).toEqual(["room"]);
    expect(deriveUnreadChannelIds(base, current, "room")).toEqual([]);
  });
});
