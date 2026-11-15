import { describe, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
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

describe("notification click targets", () => {
  test("preserves exact message routing and removes presentation fields", () => {
    expect(
      parseNotificationTarget({
        channelId: "chat",
        messageId: "message",
        messageSequence: "27",
        threadMessageId: "reply",
        title: "Private title",
        body: "Private content",
      })
    ).toEqual({
      channelId: "chat",
      messageId: "message",
      messageSequence: "27",
      threadMessageId: "reply",
    });
    expect(parseNotificationTarget({ channelId: "chat" })).toEqual({ channelId: "chat" });
  });

  test("rejects malformed targets at the IPC boundary", () => {
    for (const value of [
      null,
      [],
      {},
      { channelId: "" },
      { channelId: "x".repeat(129) },
      { channelId: "chat", messageId: "" },
      { channelId: "chat", threadMessageId: 5 },
      { channelId: "chat", messageSequence: "-1" },
      { channelId: "chat", messageSequence: 25 },
      { channelId: "chat", messageSequence: "1".repeat(21) },
    ]) {
      expect(parseNotificationTarget(value)).toBeNull();
    }
  });
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
  options: {
    focused?: () => boolean;
    supported?: () => boolean;
    honorCancellation?: boolean;
    observeDelivery?: (event: DesktopNotificationEvent) => void;
  } = {}
) => {
  let now = 10_000;
  const timers = new Map<object, { at: number; callback: () => void }>();
  const advance = (ms: number) => {
    const until = now + ms;
    while (true) {
      const next = [...timers]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
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
      deliver: (event) => {
        delivered.push(event);
        options.observeDelivery?.(event);
      },
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
    now: () => now,
  };
};

describe("DesktopNotificationManager", () => {
  test("validates local read state without accepting presentation fields", () => {
    expect(
      parseNotificationReadState({
        channelId: "chat",
        lastReadSequence: "20",
        lastReadNotificationSequence: "3",
        body: "ignored",
      })
    ).toEqual({ channelId: "chat", lastReadSequence: "20", lastReadNotificationSequence: "3" });
    for (const value of [
      null,
      [],
      {},
      { channelId: "chat", lastReadSequence: "20" },
      ...["", " ", "x".repeat(129), 5].map((channelId) => ({
        channelId,
        lastReadSequence: "20",
        lastReadNotificationSequence: "3",
      })),
      ...["-1", "1.5", "x", "1".repeat(21), 5].flatMap((sequence) => [
        { channelId: "chat", lastReadSequence: sequence, lastReadNotificationSequence: "0" },
        { channelId: "chat", lastReadSequence: "0", lastReadNotificationSequence: sequence },
      ]),
    ])
      expect(parseNotificationReadState(value)).toBeNull();
  });

  test("waits for the delivery deadline and rechecks native focus", () => {
    let focused = false;
    const { manager, ids, advance, pendingTimers } = harness({ focused: () => focused });
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    advance(NOTIFICATION_DELIVERY_DELAY_MS - 1);
    expect(ids()).toEqual([]);
    focused = true;
    advance(1);
    expect(ids()).toEqual([]);
    expect(pendingTimers()).toBe(0);
    focused = false;
    manager.sync({ channels: [channel([alert(1)])] });
    advance(6_000);
    expect(ids()).toEqual([]);
  });

  test("a brief focus transition consumes pending banners across conversations", () => {
    const { manager, ids, flush, pendingTimers } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    manager.setVisibleChannel("another-chat");
    manager.setVisibleChannel(null);
    flush();
    expect(ids()).toEqual([]);
    expect(pendingTimers()).toBe(0);
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    flush();
    expect(ids()).toEqual(["chat:2"]);
  });

  test("a focused native sync consumes earlier pending banners even before renderer focus arrives", () => {
    let focused = false;
    const { manager, ids, flush, advance } = harness({ focused: () => focused });
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    advance(100);
    focused = true;
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    focused = false;
    flush();
    expect(ids()).toEqual([]);
  });

  test("focus and read changes on either side of the delivery deadline have deterministic outcomes", () => {
    for (const delay of [0, 1, 100, 149, 250, 299, 300, 301, 650]) {
      for (const change of ["focus", "local-read", "remote-read", "clear"] as const) {
        let focused = false;
        const { manager, ids, dismissed, advance } = harness({ focused: () => focused });
        manager.sync({ channels: [channel([])] });
        manager.sync({ channels: [channel([alert(1)])] });
        advance(delay);
        if (change === "focus") {
          focused = true;
          manager.setVisibleChannel("chat");
        } else if (change === "local-read") {
          manager.markRead({
            channelId: "chat",
            lastReadSequence: "10",
            lastReadNotificationSequence: "1",
          });
        } else if (change === "remote-read") {
          manager.sync({ channels: [channel([alert(1)], { lastReadSequence: "10" })] });
        } else {
          manager.clear();
        }
        advance(1_000);
        expect(ids()).toHaveLength(delay < NOTIFICATION_DELIVERY_DELAY_MS ? 0 : 1);
        expect(dismissed).toHaveLength(
          change !== "focus" && delay >= NOTIFICATION_DELIVERY_DELAY_MS ? 1 : 0
        );
        manager.clear();
      }
    }
  });

  test("40,000 seeded message/read/focus/reconnect operations preserve delivery invariants", () => {
    let observedDeliveries = 0;
    for (let seed = 1; seed <= 200; seed++) {
      let randomState = seed;
      const random = (limit: number) => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState % limit;
      };
      let focused = false;
      let revision = 0;
      const states = ["a", "b", "c", "d"].map((id) => ({ id, sequence: 0, local: 0, remote: 0 }));
      const lastDelivered = new Map<string, number>();
      const deliveredIds = new Set<string>();
      const h = harness({
        focused: () => focused,
        observeDelivery: (event) => {
          observedDeliveries++;
          const state = states.find((value) => value.id === event.channelId)!;
          assert(!focused, `seed ${seed}: delivered into focused window`);
          assert(
            Number(event.messageSequence) > Math.max(state.local, state.remote) * 10,
            `seed ${seed}: delivered a viewed/read message`
          );
          assert(!deliveredIds.has(event.notificationId), `seed ${seed}: replayed a notification`);
          const previous = lastDelivered.get(event.channelId);
          assert(
            previous === undefined || h.now() - previous >= 5_000,
            `seed ${seed}: delivered inside conversation throttle`
          );
          lastDelivered.set(event.channelId, h.now());
          deliveredIds.add(event.notificationId);
        },
      });
      let prior: DesktopNotificationSnapshot | undefined;
      const publish = () => {
        const snapshot = {
          cursor: String(++revision),
          channels: states.map((state) =>
            channel(
              Array.from({ length: Math.min(state.sequence, 20) }, (_, index) =>
                alert(state.sequence - index, { channelId: state.id })
              ),
              { channelId: state.id, lastReadSequence: String(state.remote * 10) }
            )
          ),
        };
        h.manager.sync(snapshot);
        prior = snapshot;
      };
      publish();
      for (let step = 0; step < 200; step++) {
        const state = states[random(states.length)]!;
        switch (random(9)) {
          case 0:
          case 1:
            state.sequence++;
            publish();
            break;
          case 2:
            state.local = Math.max(state.local, random(state.sequence + 1));
            h.manager.markRead({
              channelId: state.id,
              lastReadSequence: String(state.local * 10),
              lastReadNotificationSequence: "0",
            });
            break;
          case 3:
            state.remote = Math.max(state.remote, random(state.sequence + 1));
            publish();
            break;
          case 4:
            focused = !focused;
            publish();
            break;
          case 5:
            focused = true;
            h.manager.setVisibleChannel(state.id);
            focused = false;
            h.manager.setVisibleChannel(null);
            break;
          case 6:
            h.manager.clear();
            states.forEach((value) => {
              value.local = 0;
            });
            lastDelivered.clear();
            deliveredIds.clear();
            publish();
            break;
          case 7:
            if (prior) h.manager.sync({ ...prior, cursor: String(Math.max(0, revision - 1)) });
            break;
          case 8:
            h.advance(random(6_001));
            break;
        }
      }
      h.advance(6_000);
      h.manager.clear();
      expect(h.pendingTimers()).toBe(0);
    }
    expect(observedDeliveries).toBeGreaterThan(100);
  });

  test("a read on another device cancels a banner before it appears", () => {
    const { manager, ids, dismissed, flush, pendingTimers } = harness();
    manager.sync({ cursor: "1", channels: [channel([])] });
    manager.sync({ cursor: "2", channels: [channel([alert(1)])] });
    manager.sync({
      cursor: "3",
      channels: [channel([], { notificationCursor: "1", lastReadSequence: "10" })],
    });
    flush();
    expect(ids()).toEqual([]);
    expect(dismissed).toEqual([]);
    expect(pendingTimers()).toBe(0);
  });

  test("a local read preceding an unread projection survives a slow or failed server read", () => {
    const { manager, ids, flush, advance } = harness();
    manager.sync({ channels: [channel([])] });
    manager.markRead({
      channelId: "chat",
      lastReadSequence: "10",
      lastReadNotificationSequence: "1",
    });
    manager.sync({ channels: [channel([alert(1)])] });
    advance(30_000);
    // The server still reports unread. Only the viewed message is suppressed.
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    flush();
    expect(ids()).toEqual(["chat:2"]);
  });

  test("a local read cancels a pending banner without waiting for an acknowledgement", () => {
    const { manager, ids, flush, pendingTimers } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    manager.markRead({
      channelId: "chat",
      lastReadSequence: "10",
      lastReadNotificationSequence: "1",
    });
    flush();
    expect(ids()).toEqual([]);
    expect(pendingTimers()).toBe(0);
  });

  test("local reads are monotonic and dismiss only banners through the viewed message", () => {
    const { manager, ids, dismissed, flush, advance } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    flush();
    manager.markRead({
      channelId: "chat",
      lastReadSequence: "10",
      lastReadNotificationSequence: "1",
    });
    manager.markRead({
      channelId: "chat",
      lastReadSequence: "0",
      lastReadNotificationSequence: "0",
    });
    expect(dismissed).toEqual(["chat:1"]);
    advance(5_000);
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    flush();
    expect(ids()).toEqual(["chat:1", "chat:2"]);
    expect(dismissed).toEqual(["chat:1"]);
  });

  test("updates a pending conversation to its newest message without extending the deadline", () => {
    const { manager, ids, advance, pendingTimers } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    advance(200);
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    expect(pendingTimers()).toBe(1);
    advance(100);
    expect(ids()).toEqual(["chat:2"]);
  });

  test("clears timers and local reads across sign-out or a server switch", () => {
    const { manager, ids, flush, pendingTimers } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    manager.markRead({
      channelId: "chat",
      lastReadSequence: "100",
      lastReadNotificationSequence: "10",
    });
    manager.clear();
    expect(pendingTimers()).toBe(0);
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    flush();
    expect(ids()).toEqual(["chat:1"]);
  });

  test("removing a channel cancels its pending delivery", () => {
    const { manager, ids, flush, pendingTimers } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    manager.sync({ channels: [] });
    flush();
    expect(ids()).toEqual([]);
    expect(pendingTimers()).toBe(0);
  });

  test("a canceled callback cannot publish into a new session", () => {
    const { manager, ids, flush } = harness({ honorCancellation: false });
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    manager.clear();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(2)])] });
    flush();
    expect(ids()).toEqual(["chat:2"]);
  });

  test("stale snapshots cannot cancel a newer pending banner", () => {
    const { manager, ids, flush } = harness();
    manager.sync({ cursor: "1", channels: [channel([])] });
    manager.sync({ cursor: "3", channels: [channel([alert(2)])] });
    manager.sync({ cursor: "2", channels: [] });
    flush();
    expect(ids()).toEqual(["chat:2"]);
  });

  test("losing native notification support during the grace period prevents delivery", () => {
    let supported = true;
    const { manager, ids, flush, pendingTimers } = harness({ supported: () => supported });
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    supported = false;
    flush();
    expect(ids()).toEqual([]);
    expect(pendingTimers()).toBe(0);
    supported = true;
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    flush();
    expect(ids()).toEqual(["chat:2"]);
  });

  test("local read suppression keeps full sequence precision and is scoped to its channel", () => {
    const { manager, ids, flush } = harness();
    const other = channel([], { channelId: "other" });
    manager.sync({ channels: [channel([]), other] });
    manager.markRead({
      channelId: "chat",
      lastReadSequence: "9007199254740992",
      lastReadNotificationSequence: "0",
    });
    manager.sync({
      channels: [
        channel([alert(1, { messageSequence: "9007199254740993" })]),
        channel([alert(1, { channelId: "other" })], { channelId: "other" }),
      ],
    });
    flush();
    expect(ids()).toEqual(["chat:1", "other:1"]);
  });

  test("a partial local read preserves the newer message already pending", () => {
    const { manager, ids, flush } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1), alert(2)])] });
    manager.markRead({
      channelId: "chat",
      lastReadSequence: "10",
      lastReadNotificationSequence: "1",
    });
    flush();
    expect(ids()).toEqual(["chat:2"]);
  });

  test("seeds silently, delivers each new message once, and closes it when read anywhere", () => {
    const { manager, ids, dismissed, flush } = harness();
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
  });

  test("closes delivered banners on sign-out", () => {
    const { manager, dismissed, flush } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1)])] });
    flush();
    manager.clear();
    expect(dismissed).toEqual(["chat:1"]);
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
    advance(3_900);
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3)]), room([7])] });
    flush();
    // Message 2 landed inside message 1's window and is never shown later.
    expect(ids()).toEqual(["chat:1", "room:7", "chat:3"]);
  });

  test("carries a thread reply's id so opening the banner opens its thread", () => {
    const { manager, delivered, flush } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1, { threadMessageId: "reply-1" })])] });
    flush();
    expect(delivered.map(({ threadMessageId }) => threadMessageId)).toEqual(["reply-1"]);
  });

  test("shows only the newest alert when several arrive together", () => {
    const { manager, delivered, flush } = harness();
    manager.sync({ channels: [channel([])] });
    manager.sync({ channels: [channel([alert(1), alert(2), alert(3)])] });
    flush();
    expect(delivered.map(({ body }) => body)).toEqual(["Message 3"]);
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

  test("shows unread questions as banners only when the app is in the background", () => {
    let focused = true;
    const { manager, delivered, flush } = harness({ focused: () => focused });
    manager.setVisibleChannel("another-chat");
    manager.sync({ channels: [channel([])] });
    manager.sync({
      channels: [channel([alert(1, { title: "Question QA", body: "Which sample color?" })])],
    });
    expect(delivered).toEqual([]);
    focused = false;
    manager.sync({
      channels: [channel([alert(2, { title: "Question QA", body: "Which sample animal?" })])],
    });
    flush();
    expect(delivered.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "Question QA", body: "Which sample animal?" },
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
