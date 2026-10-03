import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { subscribeDayClock } from "../../src/renderer/lib/day-clock";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  setSystemTime();
});

function mountClock() {
  const target = new EventTarget();
  const page = new EventTarget();
  let pending: (() => void) | undefined;
  let delay = 0;
  const host = Object.assign(target, {
    setTimeout(callback: TimerHandler, timeout?: number) {
      pending = callback as () => void;
      delay = timeout ?? 0;
      return 1;
    },
    clearTimeout() { pending = undefined; },
  });
  const dates: Date[] = [];
  dispose = subscribeDayClock(date => dates.push(date), host as unknown as Window, page);
  return { dates, target, page, tick: () => pending?.(), delay: () => delay, pending: () => pending };
}

describe("transcript day clock", () => {
  test("refreshes an open transcript at local midnight without message activity", () => {
    setSystemTime(new Date(2026, 9, 3, 23, 59, 59, 500));
    const clock = mountClock();
    expect(clock.delay()).toBe(500);
    setSystemTime(new Date(2026, 9, 4, 0, 0));
    clock.tick();
    expect(clock.dates.map(date => date.getDate())).toEqual([3, 4]);
    expect(clock.delay()).toBe(60_000);
    clock.tick();
    expect(clock.dates).toHaveLength(2);
  });

  test("catches a missed midnight on focus or visibility changes and cleans up", () => {
    setSystemTime(new Date(2026, 9, 3, 20, 23));
    const clock = mountClock();
    setSystemTime(new Date(2026, 9, 4, 0, 23));
    clock.target.dispatchEvent(new Event("focus"));
    expect(clock.dates.map(date => date.getDate())).toEqual([3, 4]);
    setSystemTime(new Date(2026, 9, 5, 8));
    clock.page.dispatchEvent(new Event("visibilitychange"));
    expect(clock.dates.map(date => date.getDate())).toEqual([3, 4, 5]);
    dispose?.();
    expect(clock.pending()).toBeUndefined();
    setSystemTime(new Date(2026, 9, 6, 8));
    clock.target.dispatchEvent(new Event("focus"));
    clock.page.dispatchEvent(new Event("visibilitychange"));
    expect(clock.dates).toHaveLength(3);
  });

  test("detects clock jumps during an active session", () => {
    setSystemTime(new Date(2026, 9, 3, 20));
    const clock = mountClock();
    setSystemTime(new Date(2026, 9, 4, 0, 23));
    clock.tick();
    expect(clock.dates.map(date => date.getDate())).toEqual([3, 4]);
    setSystemTime(new Date(2026, 9, 3, 23));
    clock.tick();
    expect(clock.dates.map(date => date.getDate())).toEqual([3, 4, 3]);
  });
});
