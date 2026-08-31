import { describe, expect, test } from "bun:test";
import {
  channelIdFromNotificationData,
  foregroundNotificationBehavior,
} from "../src/notification-policy";

describe("iOS notification policy", () => {
  test("suppresses a foreground banner for the open conversation", () => {
    expect(foregroundNotificationBehavior("channel-1", "channel-1", "agent-needs-input")).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  test("shows other conversations and only sounds for input", () => {
    expect(foregroundNotificationBehavior("channel-2", "channel-1", "agent-done")).toMatchObject({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
    });
    expect(
      foregroundNotificationBehavior("channel-2", "channel-1", "agent-needs-input").shouldPlaySound
    ).toBe(true);
  });

  test("never surfaces a cross-device badge synchronization as an alert", () => {
    expect(foregroundNotificationBehavior(null, null, "badge-sync")).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  test("extracts only valid deep-link channel identifiers", () => {
    expect(channelIdFromNotificationData({ channelId: "channel-1" })).toBe("channel-1");
    expect(channelIdFromNotificationData({ channelId: 1 })).toBeNull();
    expect(channelIdFromNotificationData(null)).toBeNull();
  });
});
