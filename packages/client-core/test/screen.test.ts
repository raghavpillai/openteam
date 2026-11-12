import { describe, expect, test } from "bun:test";
import { createScreenSessionController } from "../src";
import { createComputerControlController, ownsComputerControl } from "../src/computer-control";
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

const status = (id: string | null, generation = 1) =>
  ({ humanTakeover: !!id, controlSession: id ? { id, generation } : null }) as ScreenStatusView;
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
