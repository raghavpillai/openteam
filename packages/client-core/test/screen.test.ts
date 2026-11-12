import { describe, expect, test } from "bun:test";
import { createScreenSessionController } from "../src";
import { createSerialPoller } from "../src/async";
import { createComputerControlController, ownsComputerControl } from "../src/computer-control";
import { createHandoffReleaseController } from "../src/screen";
import type { ScreenStatusView } from "@openteam/contracts";

describe("shared screen session controller", () => {
  test("polls only while active and releases takeover on suspension", async () => {
    let polls = 0;
    const requests: boolean[] = [];
    const results: boolean[] = [];
    const controller = createScreenSessionController({
      pollIntervalMs: 60_000,
      heartbeatMs: 60_000,
      pollStatus: async () => {
        polls += 1;
      },
      requestTakeover: async (active) => {
        requests.push(active);
        return { humanTakeover: active };
      },
      onTakeoverResult: (result) => results.push(result.humanTakeover),
    });

    controller.activate();
    await Promise.resolve();
    expect(polls).toBe(1);
    controller.setTakeover(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual([true]);
    expect(results).toEqual([true]);

    controller.deactivate();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual([true, false]);
    controller.wake();
    await Promise.resolve();
    expect(polls).toBe(1);
    controller.stop();
  });
});

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

const status = (id: string | null, generation = 1) =>
  ({ humanTakeover: !!id, controlSession: id ? { id, generation } : null }) as ScreenStatusView;
test("closing during acquisition releases the returned generation without a render", async () => {
  let complete!: (s: ScreenStatusView) => void;
  const calls: unknown[] = [];
  const c = createComputerControlController("desktop", async (active, input) => {
    calls.push({ active, ...input });
    return active
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : status(null);
  });
  c.open();
  const pending = c.take();
  const closing = c.close();
  complete(status("desktop", 42));
  await Promise.all([pending, closing]);
  expect(calls).toEqual([
    { active: true, controlId: "desktop", force: false },
    { active: false, controlId: "desktop", generation: 42 },
  ]);
});
test("watching a different owner never releases their session", async () => {
  let calls = 0;
  const c = createComputerControlController("ios", async () => {
    calls++;
    return status(null);
  });
  c.open();
  c.observe(status("desktop"));
  await c.close();
  expect(calls).toBe(0);
  expect(ownsComputerControl(status("desktop"), "ios")).toBe(false);
});
test("reconnection observes existing ownership without issuing acquisition or renewals", async () => {
  const calls: unknown[] = [];
  const c = createComputerControlController("desktop", async (active, input) => {
    calls.push({ active, ...input });
    return status(null);
  });
  c.open();
  c.observe(status("desktop", 3));
  c.observe(status("desktop", 3));
  expect(calls).toEqual([]);
  await c.giveBack();
  expect(calls).toEqual([{ active: false, controlId: "desktop", generation: 3 }]);
});
test("unsupported servers cannot silently acquire a renewable legacy lease", async () => {
  const c = createComputerControlController(
    "desktop",
    async () => ({ humanTakeover: true }) as ScreenStatusView
  );
  await expect(c.take()).rejects.toThrow("Update your OpenTeam server");
});
