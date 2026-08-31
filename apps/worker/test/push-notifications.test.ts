import { describe, expect, test } from "bun:test";
import {
  approvalReason,
  expoPushMessage,
  truncateNotificationBody,
} from "../src/push-notifications";

describe("push notification content", () => {
  test("prefers a bounded approval reason and normalizes whitespace", () => {
    expect(approvalReason({ reason: "  Approve\nthis   command  " })).toBe("Approve this command");
    expect(approvalReason({ command: "bun test" })).toBe("bun test");
    expect(approvalReason(null)).toBe("Waiting for your input.");
  });

  test("truncates by grapheme without splitting a joined emoji family", () => {
    const family = "👨‍👩‍👧‍👦";
    const result = truncateNotificationBody(`  ${family.repeat(145)}  `);
    expect([
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(result),
    ]).toHaveLength(140);
    expect(result.endsWith("…")).toBe(true);
  });

  test("uses exact badge counts and the shared per-type sound policy", () => {
    const message = expoPushMessage("ExpoPushToken[token]", {
      schemaVersion: 1,
      kind: "agent-done",
      botId: "bot",
      channelId: "channel",
      runId: "run",
      title: "Probe",
      body: "Done",
      deepLink: "openbot:///chat/channel",
      badgeCount: 4,
    });
    expect(message).toMatchObject({ badge: 4, sound: undefined, data: { badgeCount: 4 } });
    expect(
      expoPushMessage("ExpoPushToken[token]", {
        schemaVersion: 1,
        kind: "agent-needs-input",
        botId: "bot",
        channelId: "channel",
        runId: "run",
        approvalId: "approval",
        title: "Probe needs you",
        body: "Approve the command",
        deepLink: "openbot:///chat/channel",
        badgeCount: 4,
      })
    ).toMatchObject({
      title: "Probe needs you",
      body: "Approve the command",
      sound: "default",
      badge: 4,
    });
    expect(
      expoPushMessage("ExpoPushToken[token]", {
        schemaVersion: 1,
        kind: "badge-sync",
        badgeCount: 2,
      })
    ).toEqual({
      to: "ExpoPushToken[token]",
      badge: 2,
      data: { schemaVersion: 1, kind: "badge-sync", badgeCount: 2 },
    });
  });
});
