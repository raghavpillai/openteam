import { describe, expect, test } from "bun:test";
import {
  type DesktopAgentNotificationState,
  DesktopNotificationManager,
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
        title: "Probe needs you",
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
});
