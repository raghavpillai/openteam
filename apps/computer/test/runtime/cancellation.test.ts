import { expect, test } from "bun:test";
import { ComputerRuntime } from "../../src/runtime";
import type { ActiveTurn } from "../../src/runtime/types";

test("cancellation is accepted during session setup and signals pending work", async () => {
  const runtime = new ComputerRuntime();
  const controller = new AbortController();
  const stopped: string[] = [];
  const internals = runtime as unknown as {
    activeByRun: Map<string, ActiveTurn>;
    tools: { cancelApprovals: (id: string) => void; interruptShellWaits: (id: string) => void };
  };
  internals.tools.cancelApprovals = (id) => {
    stopped.push(`approval:${id}`);
  };
  internals.tools.interruptShellWaits = (id) => {
    stopped.push(`wait:${id}`);
  };
  internals.activeByRun.set("starting", {
    session: null,
    pluginAbortController: controller,
  } as ActiveTurn);
  await runtime.cancel("starting");
  expect(controller.signal.aborted).toBe(true);
  expect(stopped).toEqual(["approval:starting", "wait:starting"]);
  expect(() => controller.signal.throwIfAborted()).toThrow();
  await expect(runtime.cancel("missing")).rejects.toThrow("not actively executing");
});
