import { describe, expect, test } from "bun:test";
import { EventWakeup } from "../src/event-wakeup";

describe("event wakeup", () => {
  test("does not lose a notification between query and wait", async () => {
    const wakeup = new EventWakeup("postgresql://unused");
    const observed = wakeup.currentVersion;
    wakeup.notify();

    expect(await wakeup.wait(observed, 10_000)).toBe(observed + 1);
  });

  test("fans one notification out to concurrent waiters", async () => {
    const wakeup = new EventWakeup("postgresql://unused");
    const observed = wakeup.currentVersion;
    const waits = [wakeup.wait(observed, 10_000), wakeup.wait(observed, 10_000)];
    wakeup.notify();

    expect(await Promise.all(waits)).toEqual([observed + 1, observed + 1]);
  });
});
