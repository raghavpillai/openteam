import { expect, test } from "bun:test";
import {
  startNotificationPresence,
  type DesktopActivity,
} from "../src/renderer/lib/notification-presence";
import type { NotificationPresenceInput } from "@openteam/contracts/notification-presence";
import { syncDesktopNotificationSnapshot } from "../src/renderer/lib/notifications";

test("sign-out clears the native notification state", () => {
  let clears = 0;
  expect(
    syncDesktopNotificationSnapshot(
      {
        sync: () => {},
        clear: () => {
          clears++;
        },
      },
      null
    )
  ).toBeFalse();
  expect(clears).toBe(1);
});

test("a lock transition overtakes a slow activity sample and unmount releases the same lease", async () => {
  const sent: NotificationPresenceInput[] = [];
  let changed = () => {};
  let resolve!: (value: DesktopActivity) => void;
  let reads = 0;
  const stop = startNotificationPresence({
    activity: async () =>
      ++reads === 1
        ? new Promise<DesktopActivity>((done) => {
            resolve = done;
          })
        : { active: false, idleSeconds: 0 },
    send: async (input) => {
      sent.push(input);
    },
    release: (input) => {
      sent.push(input);
    },
    subscribe: (callback) => {
      changed = callback;
      return () => {};
    },
  });
  changed();
  await Bun.sleep(0);
  resolve({ active: true, idleSeconds: 0 });
  await Bun.sleep(0);
  stop();
  stop();
  expect(sent.map((input) => [input.sequence, input.active])).toEqual([
    [2, false],
    [3, false],
  ]);
  expect(sent[0]!.clientId).toBe(sent[1]!.clientId);
});

test("heartbeats renew availability without extending the Mac idle threshold; stop cancels renewal", async () => {
  const sent: NotificationPresenceInput[] = [];
  const stop = startNotificationPresence({
    activity: async () => ({ active: true, idleSeconds: 299 }),
    send: async (input) => {
      sent.push(input);
    },
    release: (input) => {
      sent.push(input);
    },
    subscribe: () => () => {},
    intervalMs: 5,
  });
  try {
    const end = Date.now() + 500;
    while (sent.length < 2 && Date.now() < end) await Bun.sleep(5);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.every((input) => input.idleSeconds === 299)).toBeTrue();
  } finally {
    stop();
  }
  const count = sent.length;
  await Bun.sleep(15);
  expect(sent).toHaveLength(count);
  expect(sent.at(-1)!.active).toBeFalse();
});
