import { describe, expect, test } from "bun:test";
import {
  type DesktopAgentNotificationState,
  DesktopNotificationManager,
  desktopActivityNotificationId,
} from "../src/main/notifications";

const agent = (
  patch: Partial<DesktopAgentNotificationState> = {}
): DesktopAgentNotificationState => ({
  botId: "bot-1",
  channelId: "channel-1",
  name: "Probe",
  notificationsEnabled: true,
  hiddenFromSidebar: false,
  isRunning: true,
  awaitingReason: null,
  lastMessageId: "before",
  lastMessagePreview: "Earlier answer",
  unreadCount: 0,
  ...patch,
});

describe("DesktopNotificationManager", () => {
  test("delivers individual messages and reactions, clears remote reads, and preserves newer alerts", () => {
    const delivered: string[] = [];
    const dismissed: string[] = [];
    const manager = new DesktopNotificationManager({
      isFocused: () => true,
      isSupported: () => true,
      deliver: (event) => delivered.push(event.notificationId!),
      dismiss: (id) => dismissed.push(id),
      setBadge: () => {},
    });
    manager.setVisibleChannel("another-channel");
    const channel = {
      channelId: "chat",
      lastReadSequence: "0",
      lastReadNotificationSequence: "0",
      notificationCursor: "0",
      notifications: [],
      unreadCount: 0,
      activityUnreadCount: 0,
    };
    const message = {
      channelId: "chat",
      botId: "bot",
      kind: "message" as const,
      notificationSequence: "1",
      messageSequence: "20",
      title: "Bot",
      body: "Hello",
    };
    manager.sync({ agents: [], channels: [channel] });
    manager.sync({
      agents: [],
      channels: [{ ...channel, notificationCursor: "1", notifications: [message], unreadCount: 1 }],
    });
    manager.sync({
      agents: [],
      channels: [{ ...channel, lastReadSequence: "20", notificationCursor: "1" }],
    });
    const reaction = {
      ...message,
      kind: "reaction" as const,
      notificationSequence: "2",
      messageSequence: "3",
      body: "Reacted 👍",
    };
    manager.sync({
      agents: [],
      channels: [
        {
          ...channel,
          lastReadSequence: "20",
          notificationCursor: "2",
          notifications: [reaction],
          unreadCount: 1,
        },
      ],
    });
    expect(delivered).toEqual(["openteam:chat:1:20", "openteam:chat:2:activity"]);
    expect(dismissed).toEqual(["openteam:chat:1:20"]);
    manager.sync({
      agents: [],
      channels: [
        {
          ...channel,
          lastReadSequence: "20",
          lastReadNotificationSequence: "2",
          notificationCursor: "2",
          notifications: [reaction],
        },
      ],
    });
    expect(dismissed).toEqual(["openteam:chat:1:20", "openteam:chat:2:activity"]);
    const alreadyRead = { ...message, notificationSequence: "3" };
    manager.sync({
      agents: [],
      channels: [
        {
          ...channel,
          lastReadSequence: "20",
          notificationCursor: "3",
          notifications: [alreadyRead],
        },
      ],
    });
    expect(delivered).toHaveLength(2);
  });
  test("restores notification history after restart and clears only acknowledged messages and reactions", () => {
    const dismissed: string[] = [];
    const delivered: string[] = [];
    const manager = new DesktopNotificationManager({
      isFocused: () => false,
      isSupported: () => true,
      deliver: (event) => delivered.push(event.notificationId!),
      dismiss: (id) => dismissed.push(id),
      setBadge: () => {},
    });
    const message = {
      channelId: "chat",
      notificationSequence: "11",
      messageSequence: "9007199254740993",
      kind: "message" as const,
    };
    const oldId = desktopActivityNotificationId(message);
    const newId = desktopActivityNotificationId({
      ...message,
      notificationSequence: "12",
      messageSequence: "9007199254740994",
    });
    const reactionId = desktopActivityNotificationId({
      ...message,
      notificationSequence: "13",
      kind: "reaction",
    });
    manager.restoreDeliveredActivity([
      oldId,
      newId,
      reactionId,
      "chat:10",
      "unrelated",
      "openteam:chat:invalid:4",
    ]);
    const channel = {
      channelId: "chat",
      lastReadSequence: "9007199254740993",
      lastReadNotificationSequence: "11",
      notificationCursor: "13",
      notifications: [],
      unreadCount: 2,
      activityUnreadCount: 1,
    };
    manager.sync({ agents: [], channels: [channel] });
    expect(dismissed).toEqual([oldId, "chat:10"]);
    expect(delivered).toEqual([]);
    // Bounded snapshot history being empty must not remove the newer unread alerts.
    manager.sync({ agents: [], channels: [{ ...channel, lastReadNotificationSequence: "13" }] });
    expect(dismissed).toEqual([oldId, "chat:10", reactionId]);
    manager.clear();
    expect(dismissed).toEqual([oldId, "chat:10", reactionId, newId]);
  });

  test("seeds silently, gives needs-input precedence, and delivers a later done message", () => {
    const delivered: Array<{ kind: string; title: string; body: string; sound: string | null }> =
      [];
    const badges: string[] = [];
    const manager = new DesktopNotificationManager({
      isFocused: () => false,
      isSupported: () => true,
      deliver: ({ kind, title, body, sound }) => delivered.push({ kind, title, body, sound }),
      setBadge: (label) => badges.push(label),
    });

    manager.sync({ agents: [agent()] });
    manager.sync({
      agents: [agent({ awaitingReason: "Approve the command", unreadCount: 1 })],
    });
    manager.sync({
      agents: [
        agent({
          isRunning: false,
          lastMessageId: "after",
          lastMessagePreview: "The command finished successfully.",
          unreadCount: 1,
        }),
      ],
    });

    expect(delivered).toEqual([
      {
        kind: "agent-needs-input",
        title: "Probe",
        body: "Approve the command",
        sound: "default",
      },
      {
        kind: "agent-done",
        title: "Probe",
        body: "The command finished successfully.",
        sound: null,
      },
    ]);
    expect(badges.at(-1)).toBe("1");
  });

  test("consumes focused and disabled transitions without replaying them", () => {
    let focused = true;
    const delivered: string[] = [];
    const manager = new DesktopNotificationManager({
      isFocused: () => focused,
      isSupported: () => true,
      deliver: (event) => delivered.push(event.kind),
      setBadge: () => undefined,
    });

    manager.sync({ agents: [agent()] });
    manager.sync({ agents: [agent({ awaitingReason: "Approve" })] });
    focused = false;
    manager.sync({ agents: [agent({ awaitingReason: "Approve" })] });
    manager.sync({
      agents: [
        agent({
          isRunning: false,
          notificationsEnabled: false,
          lastMessageId: "after",
          lastMessagePreview: "Done",
        }),
      ],
    });
    manager.sync({
      agents: [
        agent({
          isRunning: false,
          notificationsEnabled: true,
          lastMessageId: "after",
          lastMessagePreview: "Done",
        }),
      ],
    });

    expect(delivered).toEqual([]);
  });

  test("sums exact unread counts, hides hidden Bots, and rejects stale snapshots", () => {
    const badges: string[] = [];
    const manager = new DesktopNotificationManager({
      isFocused: () => false,
      isSupported: () => true,
      deliver: () => undefined,
      setBadge: (label) => badges.push(label),
    });
    manager.sync({
      cursor: "10",
      agents: [
        agent({ unreadCount: 3 }),
        agent({ botId: "bot-2", channelId: "channel-2", unreadCount: 2 }),
        agent({ botId: "bot-3", channelId: "channel-3", unreadCount: 9, hiddenFromSidebar: true }),
      ],
    });
    manager.sync({ cursor: "9", agents: [agent({ unreadCount: 1 })] });
    expect(badges).toEqual(["5"]);
  });

  test("updates the visible channel badge without another roster snapshot", () => {
    const badges: string[] = [];
    const manager = new DesktopNotificationManager({
      isFocused: () => true,
      isSupported: () => true,
      deliver: () => undefined,
      setBadge: (label) => badges.push(label),
    });
    manager.sync({
      agents: [
        agent({ unreadCount: 3 }),
        agent({ botId: "bot-2", channelId: "channel-2", unreadCount: 2 }),
      ],
    });

    manager.setVisibleChannel("channel-1");
    manager.setVisibleChannel("channel-2");
    manager.setVisibleChannel(null);

    expect(badges).toEqual(["5", "2", "3", "5"]);
  });

  test("throttles repeated transition kinds per Bot for five seconds", () => {
    let now = 10_000;
    const delivered: string[] = [];
    const manager = new DesktopNotificationManager(
      {
        isFocused: () => false,
        isSupported: () => true,
        deliver: (event) => delivered.push(event.kind),
        setBadge: () => undefined,
      },
      () => now
    );
    manager.sync({ agents: [agent()] });
    manager.sync({ agents: [agent({ awaitingReason: "First" })] });
    manager.sync({ agents: [agent({ awaitingReason: null })] });
    now += 1_000;
    manager.sync({ agents: [agent({ awaitingReason: "Second" })] });
    now += 5_000;
    manager.sync({ agents: [agent({ awaitingReason: null })] });
    manager.sync({ agents: [agent({ awaitingReason: "Third" })] });
    expect(delivered).toEqual(["agent-needs-input", "agent-needs-input"]);
  });

  test("prunes transition state when a Bot leaves the snapshot", () => {
    const delivered: string[] = [];
    const manager = new DesktopNotificationManager(
      {
        isFocused: () => false,
        isSupported: () => true,
        deliver: (event) => delivered.push(event.body),
        setBadge: () => undefined,
      },
      () => 10_000
    );

    manager.sync({ agents: [agent()] });
    manager.sync({ agents: [agent({ awaitingReason: "Before removal" })] });
    manager.sync({ agents: [] });
    manager.sync({ agents: [agent()] });
    manager.sync({ agents: [agent({ awaitingReason: "After re-adding" })] });

    expect(delivered).toEqual(["Before removal", "After re-adding"]);
  });
});
