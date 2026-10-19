import { expect, test } from "bun:test";
import { Schema } from "effect";
import { UpdateNotificationPresenceInput } from "../src";
import {
  notificationPresenceLifetime,
  suppressMobileNotification,
} from "../src/notification-presence";

const input = {
  clientId: crypto.randomUUID(),
  sequence: 1,
  platform: "macos" as const,
  active: true,
};
test("Mac system idle cutoff and disconnected-client expiry are separate limits", () => {
  expect(notificationPresenceLifetime({ ...input, idleSeconds: 0 })).toBe(60_000);
  expect(notificationPresenceLifetime({ ...input, idleSeconds: 240 })).toBe(60_000);
  expect(notificationPresenceLifetime({ ...input, idleSeconds: 299 })).toBe(1_000);
  expect(notificationPresenceLifetime({ ...input, idleSeconds: 300 })).toBe(0);
  expect(notificationPresenceLifetime(input)).toBe(0);
  expect(notificationPresenceLifetime({ ...input, active: false, idleSeconds: 0 })).toBe(0);
  expect(notificationPresenceLifetime({ ...input, platform: "ios" })).toBe(60_000);
});
test("foreground iPhone wins simultaneous activity; preference and expiry restore delivery", () => {
  const routing = {
    smartEnabled: true,
    serverTime: 10_000,
    macActiveUntil: 70_000,
    iosActiveUntil: 0,
  };
  expect(suppressMobileNotification(routing)).toBeTrue();
  expect(suppressMobileNotification({ ...routing, iosActiveUntil: 70_000 })).toBeFalse();
  expect(suppressMobileNotification(routing, 70_000)).toBeFalse();
  expect(suppressMobileNotification({ ...routing, smartEnabled: false })).toBeFalse();
});
test("presence API rejects invalid IDs, platforms, ordering and idle values", () => {
  const parse = Schema.decodeUnknownSync(UpdateNotificationPresenceInput);
  expect(parse(input)).toEqual(input);
  for (const patch of [
    { clientId: "x" },
    { platform: "android" },
    { active: "true" },
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: 2_147_483_648 },
    { idleSeconds: -1 },
    { idleSeconds: Infinity },
    { idleSeconds: NaN },
  ]) {
    expect(() => parse({ ...input, ...patch })).toThrow();
  }
});
