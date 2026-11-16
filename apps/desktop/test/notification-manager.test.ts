import { describe, expect, test } from "bun:test";
import type { ChannelNotificationView } from "@openteam/contracts/notification-content";
import {
  type DesktopNotificationEvent,
  DesktopNotificationManager,
  type DesktopNotificationSnapshot,
  parseNotificationTarget,
  parseNotificationReadState,
  NOTIFICATION_DELIVERY_DELAY_MS,
} from "../src/main/notifications";

type Channel = DesktopNotificationSnapshot["channels"][number];

test("notification click targets keep exact routing, drop presentation fields, and reject malformed IPC input", () => {
  expect(
    parseNotificationTarget({ channelId: "chat", messageId: "message", messageSequence: "27", threadMessageId: "reply", title: "Private title", body: "Private content" })
  ).toEqual({ channelId: "chat", messageId: "message", messageSequence: "27", threadMessageId: "reply" });
  for (const value of [
    null, [], {}, { channelId: "" }, { channelId: "x".repeat(129) }, { channelId: "chat", messageId: "" },
    { channelId: "chat", threadMessageId: 5 }, { channelId: "chat", messageSequence: "-1" },
    { channelId: "chat", messageSequence: 25 }, { channelId: "chat", messageSequence: "1".repeat(21) },
  ])
    expect(parseNotificationTarget(value)).toBeNull();
  expect(
    parseNotificationReadState({ channelId: "chat", lastReadSequence: "20", lastReadNotificationSequence: "3", body: "ignored" })
  ).toEqual({ channelId: "chat", lastReadSequence: "20", lastReadNotificationSequence: "3" });
  for (const value of [
    null, [], {}, { channelId: "chat", lastReadSequence: "20" },
    ...["", " ", "x".repeat(129), 5].map((channelId) => ({ channelId, lastReadSequence: "20", lastReadNotificationSequence: "3" })),
    ...["-1", "1.5", "x", "1".repeat(21), 5].flatMap((sequence) => [
      { channelId: "chat", lastReadSequence: sequence, lastReadNotificationSequence: "0" },
      { channelId: "chat", lastReadSequence: "0", lastReadNotificationSequence: sequence },
    ]),
  ])
    expect(parseNotificationReadState(value)).toBeNull();
});

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

const harness = (
  options: { focused?: () => boolean; supported?: () => boolean; honorCancellation?: boolean } = {}
) => {
  let now = 10_000;
  // A fake clock for the delivery deadline: advance() runs due timers in order.
  const timers = new Map<object, { at: number; callback: () => void }>();
  const advance = (ms: number) => {
    const until = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
    }
    now = until;
  };
  const delivered: DesktopNotificationEvent[] = [];
  const dismissed: string[] = [];
  const badges: string[] = [];
  const manager = new DesktopNotificationManager(
    {
      isFocused: options.focused ?? (() => false),
      isSupported: options.supported ?? (() => true),
      deliver: (event) => delivered.push(event),
      dismiss: (id) => dismissed.push(id),
      setBadge: (label) => badges.push(label),
    },
    () => now,
    (callback, delay) => {
      const token = {};
      timers.set(token, { at: now + delay, callback });
      return () => {
        if (options.honorCancellation !== false) timers.delete(token);
      };
    }
  );
  return {
    manager,
    delivered,
    dismissed,
    badges,
    ids: () => delivered.map((event) => event.notificationId),
    advance,
    flush: () => advance(NOTIFICATION_DELIVERY_DELAY_MS),
    pendingTimers: () => timers.size,
  };
};

describe("DesktopNotificationManager", () => {
  test("waits for the delivery deadline and drops the banner if focus or support changes before it", () => {
    let focused = false;
    let supported = true;
    const { manager, ids, advance, flush, pendingTimers } = harness({
      focused: () => focused,
      supported: () => supported,
    });
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    advance(NOTIFICATION_DELIVERY_DELAY_MS - 1);
    expect(ids()).toEqual([]);
    // Native focus is rechecked at the deadline, and the consumed message is never replayed.
    focused = true;
    advance(1);
    focused = false;
    manager.sync({ channels: [channel([alert(1)])] });
    advance(6_000);
    expect(ids()).toEqual([]);
    // A brief return to the app consumes pending banners in every conversation.
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    manager.setVisibleChannel("another-chat");
    manager.setVisibleChannel(null);
    flush();
    // A focused native sync consumes earlier pending banners before the renderer's focus IPC arrives.
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3)])] });
    advance(100);
    focused = true;
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3), alert(4)])] });
    focused = false;
    flush();
    // Losing native notification support during the delay prevents delivery.
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3), alert(4), alert(5)])] });
    supported = false;
    flush();
    expect(ids()).toEqual([]);
    expect(pendingTimers()).toBe(0);
    supported = true;
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3), alert(4), alert(5), alert(6)])] });
    flush();
    expect(ids()).toEqual(["chat:6"]);
  });

  test("focus, a read on this Mac or another device, or sign-out cancels the banner before the deadline and closes it after", () => {
    for (const delay of [0, 299, 300, 650]) {
      for (const change of ["focus", "local-read", "remote-read", "remote-read-pruned", "clear"] as const) {
        let focused = false;
        const { manager, ids, dismissed, advance, pendingTimers } = harness({ focused: () => focused });
        manager.sync({ cursor: "1", channels: [channel([])] });
        manager.sync({ cursor: "2", channels: [channel([alert(1)])] });
        advance(delay);
        if (change === "focus") {
          focused = true;
          manager.setVisibleChannel("chat");
        } else if (change === "local-read")
          manager.markRead({ channelId: "chat", lastReadSequence: "10", lastReadNotificationSequence: "1" });
        else if (change === "remote-read")
          manager.sync({ cursor: "3", channels: [channel([alert(1)], { lastReadSequence: "10" })] });
        else if (change === "remote-read-pruned")
          // The read notification has already left the projection.
          manager.sync({ cursor: "3", channels: [channel([], { notificationCursor: "1", lastReadSequence: "10" })] });
        else manager.clear();
        expect(pendingTimers()).toBe(0);
        advance(1_000);
        const shown = delay >= NOTIFICATION_DELIVERY_DELAY_MS;
        expect([change, delay, ids().length]).toEqual([change, delay, shown ? 1 : 0]);
        expect([change, delay, dismissed.length]).toEqual([change, delay, shown && change !== "focus" ? 1 : 0]);
        manager.clear();
      }
    }
  });

  test("local reads are monotonic, exact, channel-scoped, and survive a slow server read", () => {
    const { manager, ids, dismissed, flush, advance } = harness();
    manager.sync({ channels: [channel([]), channel([], { channelId: "other" })] });
    // Viewed before the server projects it as unread: suppressed even though the server still says unread.
    manager.markRead({ channelId: "chat", lastReadSequence: "10", lastReadNotificationSequence: "1" });
    manager.sync({ channels: [channel([alert(1)]), channel([alert(1, { channelId: "other" })], { channelId: "other" })] });
    flush();
    expect(ids()).toEqual(["other:1"]);
    // A partial read keeps the newer message that is already pending.
    advance(30_000);
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3)]), channel([], { channelId: "other" })] });
    manager.markRead({ channelId: "chat", lastReadSequence: "20", lastReadNotificationSequence: "2" });
    flush();
    expect(ids()).toEqual(["other:1", "chat:3"]);
    // A covering read closes the banner; an older read arriving later cannot roll suppression back.
    manager.markRead({ channelId: "chat", lastReadSequence: "30", lastReadNotificationSequence: "3" });
    expect(dismissed).toEqual(["chat:3"]);
    manager.markRead({ channelId: "chat", lastReadSequence: "40", lastReadNotificationSequence: "4" });
    manager.markRead({ channelId: "chat", lastReadSequence: "0", lastReadNotificationSequence: "0" });
    advance(5_000);
    const other = channel([], { channelId: "other" });
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3), alert(4)]), other] });
    flush();
    expect(ids()).toEqual(["other:1", "chat:3"]);
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3), alert(4), alert(5)]), other] });
    flush();
    expect(ids()).toEqual(["other:1", "chat:3", "chat:5"]);
    expect(dismissed).toEqual(["chat:3"]);
    // Sequences beyond 2^53 compare exactly.
    advance(5_000);
    manager.markRead({ channelId: "chat", lastReadSequence: "9007199254740992", lastReadNotificationSequence: "0" });
    manager.sync({ channels: [channel([alert(6, { messageSequence: "9007199254740993" })]), other] });
    flush();
    expect(ids()).toEqual(["other:1", "chat:3", "chat:5", "chat:6"]);
  });

  test("a burst updates the pending banner to its newest message without extending the deadline", () => {
    const { manager, ids, advance, pendingTimers } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    advance(200);
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    expect(pendingTimers()).toBe(1);
    advance(100);
    expect(ids()).toEqual(["chat:2"]);
  });

  test("sign-out, a server switch, or a removed channel cancels pending timers and forgets local reads", () => {
    const { manager, ids, flush } = harness({ honorCancellation: false });
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    manager.sync({ channels: [] });
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    manager.markRead({ channelId: "chat", lastReadSequence: "10", lastReadNotificationSequence: "1" });
    manager.clear();
    // The scheduler ignores cancellation here, so both stale callbacks still fire and must do nothing.
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    flush();
    expect(ids()).toEqual(["chat:1"]);
  });

  test("stale snapshots cannot cancel a newer pending banner", () => {
    const { manager, ids, flush } = harness();
    manager.sync({ cursor: "1", channels: [channel([])] });
    manager.sync({ cursor: "3", channels: [channel([alert(2)])] });
    manager.sync({ cursor: "2", channels: [] });
    flush();
    expect(ids()).toEqual(["chat:2"]);
  });

  test("seeds silently, delivers each new message once, and closes it when read anywhere", () => {
    const { manager, ids, dismissed, advance, flush } = harness();
    manager.sync({ channels: [channel([alert(1)])] });
    expect(ids()).toEqual([]);
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    flush();
    expect(ids()).toEqual(["chat:2"]);
    expect(dismissed).toEqual([]);
    // The read can come from this Mac or the iPhone; the synced read state is the same.
    manager.sync({ channels: [channel([alert(1), alert(2)], { lastReadSequence: "20" })] });
    expect(dismissed).toEqual(["chat:2"]);
    // Sign-out closes whatever is still showing.
    advance(6_000);
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3)], { lastReadSequence: "20" })] });
    flush();
    manager.clear();
    expect(dismissed).toEqual(["chat:2", "chat:3"]);
  });

  test("skips reactions and alerts that were already read on another device", () => {
    const { manager, ids, flush } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({
      channels: [
        channel([alert(1, { kind: "reaction", body: "Reacted 👍" }), alert(2)], {
          lastReadSequence: "20",
        }),
      ],
    });
    flush();
    expect(ids()).toEqual([]);
  });

  test("throttles each conversation for five seconds without replaying", () => {
    const { manager, ids, advance, flush } = harness();
    const room = (sequences: number[]) =>
      channel(
        sequences.map((sequence) => alert(sequence, { channelId: "room", botId: "other" })),
        { channelId: "room" }
      );
    manager.sync({ channels: [channel([]), room([])] });
    manager.sync({ channels: [channel([alert(1)]), room([])] });
    advance(1_500);
    manager.sync({ channels: [channel([alert(1), alert(2)]), room([7])] });
    // The window starts when chat:1 is shown, at the end of its delivery delay.
    advance(3_900);
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3)]), room([7])] });
    flush();
    // Message 2 landed inside message 1's window and is never shown later.
    expect(ids()).toEqual(["chat:1", "room:7", "chat:3"]);
  });

  test("shows only the newest of several alerts, carrying a thread reply's id so the banner opens its thread", () => {
    const { manager, delivered, flush } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3, { threadMessageId: "reply-3" })])] });
    flush();
    expect(delivered.map(({ body, threadMessageId }) => [body, threadMessageId])).toEqual([["Message 3", "reply-3"]]);
  });

  test("suppresses all chats while focused without replaying or starting a throttle window", () => {
    let focused = true;
    const { manager, ids, advance, flush } = harness({ focused: () => focused });
    manager.setVisibleChannel("another-chat");
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    expect(ids()).toEqual([]);
    focused = false;
    advance(1_000);
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    flush();
    expect(ids()).toEqual(["chat:2"]);
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
