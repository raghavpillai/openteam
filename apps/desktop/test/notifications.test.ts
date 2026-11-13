import { describe, expect, test } from "bun:test";
import type { ChannelHistoryPage, ChannelMessageView, ClientSnapshot } from "@openteam/contracts";
import {
  deriveUnreadChannelIds,
  desktopNotificationSnapshot,
  syncDesktopNotificationSnapshot,
  resolveNotificationMessage,
} from "../src/renderer/lib/notifications";

describe("desktop notification message resolution", () => {
  const message = (id: string, sequence: string, channelId = "chat") =>
    ({ id, sequence, channelId }) as ChannelMessageView;
  const page = (messages: ChannelMessageView[], channelId = "chat") =>
    ({ channelId, messages }) as ChannelHistoryPage;
  const unexpectedHistory = async (): Promise<ChannelHistoryPage> => {
    throw new Error("An identified or cached notification should not fetch history");
  };

  test("uses identified and channel-scoped cached targets without history", async () => {
    for (const [target, cached, expected] of [
      [{ channelId: "chat", messageId: "new", messageSequence: "25" }, [], { messageId: "new", sequence: "25" }],
      [{ channelId: "chat", messageSequence: "25" }, [message("wrong", "25", "other"), message("right", "25")], { messageId: "right", sequence: "25" }],
      [{ channelId: "chat", messageId: "root", threadMessageId: "reply" }, [message("reply", "26")], { messageId: "reply", sequence: "26" }],
    ] as const)
      expect(await resolveNotificationMessage(target, [...cached], unexpectedHistory)).toEqual(expected);
  });

  test("resolves legacy and channel-only targets with one bounded history request, up to the largest sequence", async () => {
    const requests: unknown[] = [];
    const history = (result: ChannelMessageView) => async (id: string, options: object) => {
      requests.push({ id, ...options });
      return page([result]);
    };
    expect(await resolveNotificationMessage({ channelId: "chat", messageSequence: "25" }, [], history(message("old", "25"))))
      .toEqual({ messageId: "old", sequence: "25" });
    const latest = message("latest", "9223372036854775807");
    for (const target of [{ channelId: "chat" }, { channelId: "chat", messageSequence: latest.sequence }])
      expect(await resolveNotificationMessage(target, [], history(latest))).toEqual({ messageId: "latest", sequence: latest.sequence });
    const unbounded = { id: "chat", beforeSequence: undefined, limit: 1 };
    expect(requests).toEqual([{ id: "chat", beforeSequence: "26", limit: 1 }, unbounded, unbounded]);
  });

  test("rejects unavailable, out-of-range, and cross-channel legacy targets", async () => {
    for (const result of [page([]), page([message("wrong", "24")]), page([message("wrong-channel", "25")], "other")]) {
      await expect(resolveNotificationMessage({ channelId: "chat", messageSequence: "25" }, [], async () => result)).rejects.toThrow("no longer available");
    }
    await expect(resolveNotificationMessage({ channelId: "chat", messageSequence: "9223372036854775808" }, [], unexpectedHistory))
      .rejects.toThrow("no longer available");
  });
});

const base = {
  bots: [{ id: "bot", name: "Probe", notificationsEnabled: true }],
  channels: [{ id: "channel", name: "Probe" }],
  channelMessages: [{ id: "before", channelId: "channel", createdAt: "2026-01-01T00:00:00Z" }],
  runs: [],
} as unknown as ClientSnapshot;

describe("desktop notification projection", () => {
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

  test("projects visible conversations and keeps muted Bots out of the badge", () => {
    const state = (channelId: string) => ({
      channelId,
      lastReadSequence: "0",
      lastReadNotificationSequence: "0",
      notificationCursor: "0",
      activityUnreadCount: 0,
      notifications: [],
    });
    const snapshot = {
      cursor: "4",
      bots: [
        { id: "bot", notificationsEnabled: true, hiddenFromSidebar: false },
        { id: "muted", notificationsEnabled: false, hiddenFromSidebar: false },
        { id: "hidden", notificationsEnabled: true, hiddenFromSidebar: true },
      ],
      channels: [
        ["dm", "bot_dm", ["bot"], 2],
        ["quiet", "bot_dm", ["muted"], 3],
        ["gone", "bot_dm", ["hidden"], 4],
        ["room", "group", ["muted", "bot"], 1],
      ].map(([id, kind, bots, unreadCount]) => ({
        id,
        kind,
        members: (bots as string[]).map((botId) => ({ botId })),
        unreadCount,
        notificationState: state(id as string),
      })),
      channelMessages: [],
      runs: [],
    } as unknown as ClientSnapshot;

    expect(
      desktopNotificationSnapshot(snapshot).channels.map(({ channelId, unreadCount }) => [
        channelId,
        unreadCount,
      ])
    ).toEqual([
      ["dm", 2],
      ["quiet", 0],
      ["room", 1],
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
    syncDesktopNotificationSnapshot(target, snapshot);
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
    syncDesktopNotificationSnapshot(target, read);
    failImage?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published.map((state) => state.cursor)).toEqual(["2"]);
    expect(activity.notifications[0]?.sender).not.toHaveProperty("avatarDataUrl");
  } finally {
    globalThis.Image = previousImage;
  }
});
