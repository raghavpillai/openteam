import { describe, expect, test } from "bun:test";
import { createSerializedTakeoverController } from "@openteam/client-core";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("serialized mobile takeover", () => {
  test("releases the server after a pending enable resolves post-blur", async () => {
    const enable = deferred<{ humanTakeover: boolean }>();
    const disable = deferred<{ humanTakeover: boolean }>();
    const calls: boolean[] = [];
    const busyChanges: boolean[] = [];
    const visibleResults: boolean[] = [];
    const controller = createSerializedTakeoverController({
      request: (active) => {
        calls.push(active);
        return active ? enable.promise : disable.promise;
      },
      onBusyChange: (busy) => busyChanges.push(busy),
      onResult: (result) => visibleResults.push(result.humanTakeover),
    });

    controller.resume();
    controller.setDesired(true);
    controller.release();
    expect(calls).toEqual([true]);

    enable.resolve({ humanTakeover: true });
    await enable.promise;
    await Promise.resolve();
    expect(calls).toEqual([true, false]);
    expect(visibleResults).toEqual([]);

    disable.resolve({ humanTakeover: false });
    await controller.whenIdle();
    expect(busyChanges).toEqual([false, true]);
    expect(visibleResults).toEqual([]);
  });

  test("coalesces queued changes to the latest desired value without overlap", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const calls: boolean[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const controller = createSerializedTakeoverController({
      request: async (active) => {
        calls.push(active);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const result = await (calls.length === 1 ? first.promise : second.promise);
        inFlight -= 1;
        return result;
      },
    });

    controller.resume();
    controller.setDesired(true);
    controller.setDesired(false);
    controller.setDesired(true);
    expect(calls).toEqual([true]);

    first.resolve(true);
    await first.promise;
    await Promise.resolve();
    expect(calls).toEqual([true, true]);
    second.resolve(true);
    await controller.whenIdle();
    expect(maxInFlight).toBe(1);
  });

  test("release writes false even when no local enable was observed", async () => {
    const calls: boolean[] = [];
    const controller = createSerializedTakeoverController({
      request: async (active) => {
        calls.push(active);
        return { humanTakeover: active };
      },
    });

    controller.release();
    await controller.whenIdle();
    expect(calls).toEqual([false]);
  });
});
