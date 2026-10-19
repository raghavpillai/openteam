import { describe, expect, test } from "bun:test";
import type { ChannelNotificationView } from "@openteam/contracts/notification-content";
import {
  type DesktopNotificationEvent,
  DesktopNotificationManager,
  type DesktopNotificationSnapshot,
} from "../src/main/notifications";

type Channel = DesktopNotificationSnapshot["channels"][number];

const alert = (
  sequence: number,
  patch: Partial<ChannelNotificationView> = {}
): ChannelNotificationView => ({
  channelId: "chat",
  botId: "bot",
  kind: "message",
  title: "Probe",
  body: `Message ${sequence}`,
  notificationSequence: String(sequence),
  messageSequence: String(sequence * 10),
  ...patch,
});

const channel = (
  notifications: ChannelNotificationView[],
  patch: Partial<Channel> = {}
): Channel => {
  const cursor = notifications.reduce(
    (max, { notificationSequence }) => Math.max(max, Number(notificationSequence)),
    0
  );
  return {
    channelId: notifications[0]?.channelId ?? "chat",
    lastReadSequence: "0",
    lastReadNotificationSequence: "0",
    notificationCursor: String(cursor),
    notifications,
    unreadCount: notifications.length,
    activityUnreadCount: 0,
    ...patch,
  };
};

const harness = (options: { focused?: () => boolean } = {}) => {
  let now = 10_000;
  const delivered: DesktopNotificationEvent[] = [];
  const dismissed: string[] = [];
  const badges: string[] = [];
  const manager = new DesktopNotificationManager(
    {
      isFocused: options.focused ?? (() => false),
      isSupported: () => true,
      deliver: (event) => delivered.push(event),
      dismiss: (id) => dismissed.push(id),
      setBadge: (label) => badges.push(label),
    },
    () => now
  );
  return {
    manager,
    delivered,
    dismissed,
    badges,
    ids: () => delivered.map((event) => event.notificationId),
    advance: (ms: number) => {
      now += ms;
    },
  };
};

test("iPhone presence consumes alerts without clearing badges or replaying them, and expires offline", () => {
  const { manager, ids, badges, advance } = harness();
  const routing = {
    smartEnabled: true,
    serverTime: 1_000_000,
    iosActiveUntil: 1_060_000,
    macActiveUntil: 1_060_000,
  };
  const snapshot = (sequence: number, notificationRouting = routing) => ({
    notificationRouting,
    channels: [channel(sequence ? [alert(sequence)] : [], { unreadCount: sequence })],
  });
  manager.sync(snapshot(0));
  manager.sync(snapshot(1));
  expect(ids()).toEqual([]);
  expect(badges.at(-1)).toBe("1");
  advance(60_000);
  manager.sync(snapshot(1)); // Reusing an old projection cannot renew a lease.
  expect(ids()).toEqual([]);
  manager.sync(snapshot(2));
  expect(ids()).toEqual(["chat:2"]);
  manager.sync(snapshot(3, { ...routing, serverTime: 1_061_000, iosActiveUntil: 1_121_000 }));
  expect(ids()).toEqual(["chat:2"]);
  advance(5_000);
  manager.sync(snapshot(4, { ...routing, smartEnabled: false, serverTime: 1_062_000 }));
  expect(ids()).toEqual(["chat:2", "chat:4"]);
  manager.clear();
  manager.sync(snapshot(0, { ...routing, smartEnabled: false, serverTime: 1 }));
  manager.sync(snapshot(1, { ...routing, smartEnabled: false, serverTime: 2 }));
  expect(ids().at(-1)).toBe("chat:1");
});

describe("DesktopNotificationManager", () => {
  test("seeds silently, then delivers each new message once and clears it when read", () => {
    const { manager, ids, dismissed } = harness();
    manager.sync({ channels: [channel([alert(1)])] });
    expect(ids()).toEqual([]);
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    expect(ids()).toEqual(["chat:2"]);
    manager.sync({ channels: [channel([alert(1), alert(2)], { lastReadSequence: "20" })] });
    expect(dismissed).toEqual(["chat:2"]);
  });

  test("skips reactions and alerts that were already read on another device", () => {
    const { manager, ids } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({
      channels: [
        channel([alert(1, { kind: "reaction", body: "Reacted 👍" }), alert(2)], {
          lastReadSequence: "20",
        }),
      ],
    });
    expect(ids()).toEqual([]);
  });

  test("throttles each conversation and kind for five seconds without replaying", () => {
    const { manager, ids, advance } = harness();
    const room = (sequences: number[]) =>
      channel(
        sequences.map((sequence) => alert(sequence, { channelId: "room", botId: "other" })),
        { channelId: "room" }
      );
    manager.sync({ channels: [channel([]), room([])] });
    manager.sync({ channels: [channel([alert(1)]), room([])] });
    advance(1_500);
    manager.sync({ channels: [channel([alert(1), alert(2)]), room([7])] });
    advance(1_000);
    manager.sync({
      channels: [channel([alert(1), alert(2), alert(3, { kind: "agent-needs-input" })]), room([7])],
    });
    advance(2_600);
    manager.sync({
      channels: [
        channel([alert(1), alert(2), alert(3, { kind: "agent-needs-input" }), alert(4)]),
        room([7]),
      ],
    });
    // Message 2 landed inside message 1's window and is never shown later.
    expect(ids()).toEqual(["chat:1", "room:7", "chat:3", "chat:4"]);
  });

  test("shows only the newest alert when several arrive together", () => {
    const { manager, delivered } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3)])] });
    expect(delivered.map(({ body }) => body)).toEqual(["Message 3"]);
  });

  test("suppresses every alert while the window is focused without starting a throttle window", () => {
    let focused = true;
    const { manager, ids, advance } = harness({ focused: () => focused });
    manager.setVisibleChannel("another-chat");
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    expect(ids()).toEqual([]);
    focused = false;
    advance(1_000);
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    expect(ids()).toEqual(["chat:2"]);
  });

  test("keeps message banners silent and sounds only for a Bot that is blocked on the user", () => {
    const { manager, delivered } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1), alert(2, { kind: "agent-needs-input" })])] });
    expect(delivered.map(({ kind, sound, urgency }) => ({ kind, sound, urgency }))).toEqual([
      { kind: "message", sound: null, urgency: "normal" },
      { kind: "agent-needs-input", sound: "default", urgency: "critical" },
    ]);
  });

  test("sums unread counts, rejects stale snapshots, and leaves the visible channel out of the badge", () => {
    const { manager, badges } = harness({ focused: () => true });
    manager.sync({
      cursor: "10",
      channels: [
        channel([], { unreadCount: 3 }),
        channel([], { channelId: "chat-2", unreadCount: 2 }),
      ],
    });
    manager.sync({ cursor: "9", channels: [channel([], { unreadCount: 1 })] });
    manager.setVisibleChannel("chat");
    manager.setVisibleChannel("chat-2");
    manager.setVisibleChannel(null);
    expect(badges).toEqual(["5", "2", "3", "5"]);
  });
});
