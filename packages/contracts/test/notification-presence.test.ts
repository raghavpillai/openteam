import { expect, test } from "bun:test";
import { suppressMobileNotification } from "../src/notification-presence";

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
