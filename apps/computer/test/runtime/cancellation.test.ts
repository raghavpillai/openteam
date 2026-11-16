import { expect, test } from "bun:test";
import { ComputerRuntime } from "../../src/runtime";
import type { ActiveTurn } from "../../src/runtime/types";

test("recovery cancellation waits for context cleanup after the model has aborted", async () => {
  const runtime = new ComputerRuntime() as any;
  let release!: () => void,
    close!: () => void,
    disposed = false,
    finished = false;
  const active = {
    runId: "recover",
    contextSessionId: "recover-context",
    subagentType: "executor",
    requestSource: "agent",
    session: {
      abort: async () => {},
      dispose: () => {
        disposed = true;
      },
    },
    contextReleased: new Promise<void>((resolve) => {
      release = resolve;
    }),
    resolveContextReleased: () => release(),
    closePluginSession: () =>
      new Promise<void>((resolve) => {
        close = resolve;
      }),
  };
  runtime.activeByRun.set(active.runId, active);
  runtime.activeByContext.set(active.contextSessionId, active);
  const cancelling = runtime.cancel(active.runId, undefined, { recovery: true }).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  const cleaning = runtime.cleanup(active);
  await new Promise((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  close();
  await cleaning;
  await cancelling;
  expect(disposed).toBe(true);
  expect(runtime.activeByContext.has(active.contextSessionId)).toBe(false);
});

test("a stop through the cancel-run API marks the turn stopped, so it settles as cancelled", async () => {
  const runtime = new ComputerRuntime();
  const internals = runtime as unknown as { activeByRun: Map<string, ActiveTurn> };
  const active = {
    session: null,
    pluginAbortController: new AbortController(),
    initialUserStarted: true,
  } as unknown as ActiveTurn;
  internals.activeByRun.set("stop", active);
  expect(await runtime.cancel("stop", "stop")).toBe(true);
  expect(active.pluginAbortController!.signal.aborted).toBe(true);
  expect(active.stopped).toBe(true);
  // As in the reference, its cut-off calls read as interrupted by the user.
  expect(active.interruptedByUserAt).toBeNumber();
});

test("a typed message leaves a run whose input has not reached the model running, unless it carries that input for recovery", async () => {
  const runtime = new ComputerRuntime();
  const internals = runtime as unknown as { activeByRun: Map<string, ActiveTurn> };
  const setup = {
    session: null,
    pluginAbortController: new AbortController(),
    initialUserStarted: false,
  } as unknown as ActiveTurn;
  internals.activeByRun.set("setup", setup);
  expect(await runtime.cancel("setup", "user_message")).toBe(false);
  expect(setup.pluginAbortController!.signal.aborted).toBe(false);
  expect(setup.endTurnRequested).toBeUndefined();
  expect(await runtime.cancel("setup", "user_message", { recovery: true })).toBe(true);
  expect(setup.pluginAbortController!.signal.aborted).toBe(true);
  // A stop cancels it either way.
  const stopped = {
    session: null,
    pluginAbortController: new AbortController(),
    initialUserStarted: false,
  } as unknown as ActiveTurn;
  internals.activeByRun.set("stopped", stopped);
  expect(await runtime.cancel("stopped")).toBe(true);
});

