import { describe, expect, test } from "bun:test";
import { createSerialPoller } from "../src/async";
import { createHandoffReleaseController } from "../src/screen";

const clock = () => {
  let nextId = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  return {
    tasks,
    schedule: (callback: () => void, delay: number) => {
      const id = ++nextId;
      tasks.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id: ReturnType<typeof setTimeout>) => {
      tasks.delete(Number(id));
    },
    tick: () => {
      const [id, task] = tasks.entries().next().value!;
      tasks.delete(id);
      task.callback();
    },
  };
};

describe("shared screen lifecycle adapters", () => {
  test("a deferred-first poll preserves the desktop cadence and never overlaps", async () => {
    const timers = clock();
    let calls = 0;
    let finish!: () => void;
    const poller = createSerialPoller({
      ...timers,
      intervalMs: 4000,
      immediate: false,
      task: () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    poller.start();
    expect(calls).toBe(0);
    expect([...timers.tasks.values()][0]!.delay).toBe(4000);
    timers.tick();
    poller.wake();
    expect(calls).toBe(1);
    poller.stop();
    finish();
    await Promise.resolve();
    expect(timers.tasks.size).toBe(0);
  });
  test("effect replay cancels dismissal; real navigation and pagehide release exactly once", () => {
    const timers = clock();
    let releases = 0;
    const lifecycle = createHandoffReleaseController({
      ...timers,
      release: () => {
        releases += 1;
      },
    });
    lifecycle.resume();
    lifecycle.deferRelease();
    lifecycle.resume();
    expect(timers.tasks.size).toBe(0);
    expect(releases).toBe(0);
    lifecycle.deferRelease();
    timers.tick();
    lifecycle.release();
    expect(releases).toBe(1);
  });
  test("an explicit finish blocks navigation dismissal and failures allow retry", () => {
    const timers = clock();
    let releases = 0;
    const lifecycle = createHandoffReleaseController({
      ...timers,
      release: () => {
        releases += 1;
      },
    });
    expect(lifecycle.beginFinish()).toBe(true);
    expect(lifecycle.beginFinish()).toBe(false);
    lifecycle.deferRelease();
    lifecycle.release();
    expect(releases).toBe(0);
    lifecycle.retry();
    lifecycle.deferRelease();
    timers.tick();
    expect(releases).toBe(1);
  });
});
