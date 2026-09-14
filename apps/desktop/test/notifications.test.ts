import { describe, expect, test } from "bun:test";
import type { ClientSnapshot } from "@openteam/contracts";
import {
  deriveAgentNotifications,
  deriveUnreadChannelIds,
  desktopNotificationSnapshot,
  syncDesktopNotificationSnapshot,
} from "../src/renderer/lib/notifications";

const base = {
  bots: [{ id: "bot", name: "Probe", notificationsEnabled: true }],
  channels: [{ id: "channel", name: "Probe" }],
  channelMessages: [{ id: "before", channelId: "channel", createdAt: "2026-01-01T00:00:00Z" }],
  runs: [],
  approvals: [],
} as unknown as ClientSnapshot;

describe("OpenTeam-compatible notification transitions", () => {
  test("creates the native projection only when a sync target can consume it", () => {
    const unreadIds = new Set(["channel"]);
    const published: ReturnType<typeof desktopNotificationSnapshot>[] = [];

    expect(syncDesktopNotificationSnapshot(undefined, base, unreadIds)).toBe(false);
    expect(published).toEqual([]);

    expect(
      syncDesktopNotificationSnapshot(
        { sync: (snapshot) => published.push(snapshot) },
        base,
        unreadIds
      )
    ).toBe(true);
    expect(published).toEqual([desktopNotificationSnapshot(base, unreadIds)]);
  });

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

  test("projects an interactive bot message as needs-input after its run ends", () => {
    const snapshot = {
      cursor: "4",
      bots: [
        {
          id: "bot",
          name: "Probe",
          notificationsEnabled: true,
          hiddenFromSidebar: false,
        },
      ],
      channels: [
        {
          id: "channel",
          kind: "bot_dm",
          name: "Probe",
          members: [{ botId: "bot" }],
          unreadCount: 1,
        },
      ],
      channelMessages: [
        {
          id: "question",
          channelId: "channel",
          senderBotId: "bot",
          content: "Deploy to production?",
          metadata: { type: "widget", interactive: true },
          createdAt: "2026-01-01T00:00:02Z",
        },
      ],
      runs: [],
      approvals: [],
    } as unknown as ClientSnapshot;

    expect(desktopNotificationSnapshot(snapshot, new Set()).agents[0]).toMatchObject({
      isRunning: false,
      awaitingReason: "Deploy to production?",
      lastMessageId: "question",
    });
  });

  test("tracks a group-origin run on the member Bot's home notification row", () => {
    const snapshot = {
      cursor: "5",
      bots: [
        {
          id: "bot",
          name: "Probe",
          notificationsEnabled: true,
          hiddenFromSidebar: false,
        },
      ],
      channels: [
        {
          id: "channel",
          kind: "bot_dm",
          name: "Probe",
          members: [{ botId: "bot" }],
          unreadCount: 0,
        },
        {
          id: "group",
          kind: "group",
          name: "Testing",
          members: [{ botId: "bot" }],
          unreadCount: 0,
        },
      ],
      channelMessages: [],
      runs: [
        {
          id: "run",
          botId: "bot",
          channelId: "group",
          status: "running",
          updatedAt: "2026-01-01T00:00:02Z",
        },
      ],
      approvals: [],
    } as unknown as ClientSnapshot;

    expect(desktopNotificationSnapshot(snapshot, new Set()).agents).toEqual([
      expect.objectContaining({
        botId: "bot",
        channelId: "channel",
        isRunning: true,
      }),
    ]);
  });
});

test("a read arriving while an icon renders supersedes the pending alert snapshot", async () => {
  const previousImage = globalThis.Image;
  let failImage: (() => void) | undefined;
  globalThis.Image = class {
    onerror?: () => void;
    set src(_value: string) {
      failImage = () => this.onerror?.();
    }
  } as unknown as typeof Image;
  try {
    const activity = {
      channelId: "channel",
      lastReadSequence: "0",
      lastReadNotificationSequence: "0",
      notificationCursor: "1",
      activityUnreadCount: 0,
      notifications: [
        {
          channelId: "channel",
          botId: "bot",
          notificationSequence: "1",
          messageSequence: "1",
          kind: "message",
          title: "Probe",
          body: "Hello",
          sender: { name: "Probe", icon: "pod", color: "#fa0123" },
        },
      ],
    };
    const snapshot = {
      ...base,
      cursor: "1",
      channels: [
        {
          id: "channel",
          kind: "bot_dm",
          members: [{ botId: "bot" }],
          unreadCount: 1,
          notificationState: activity,
        },
      ],
    } as unknown as ClientSnapshot;
    const published: ReturnType<typeof desktopNotificationSnapshot>[] = [];
    const target = {
      sync: (state: ReturnType<typeof desktopNotificationSnapshot>) => published.push(state),
    };
    syncDesktopNotificationSnapshot(target, snapshot, new Set(["channel"]));
    expect(published).toHaveLength(0);
    const read = {
      ...snapshot,
      cursor: "2",
      channels: [
        {
          ...snapshot.channels[0],
          unreadCount: 0,
          notificationState: { ...activity, lastReadSequence: "1", notifications: [] },
        },
      ],
    } as ClientSnapshot;
    syncDesktopNotificationSnapshot(target, read, new Set());
    failImage?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published.map((state) => state.cursor)).toEqual(["2"]);
    expect(activity.notifications[0]?.sender).not.toHaveProperty("avatarDataUrl");
  } finally {
    globalThis.Image = previousImage;
  }
});
