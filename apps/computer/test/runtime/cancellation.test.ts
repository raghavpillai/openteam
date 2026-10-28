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

test("cancellation is accepted during session setup and signals pending work", async () => {
  const runtime = new ComputerRuntime();
  const controller = new AbortController();
  const internals = runtime as unknown as { activeByRun: Map<string, ActiveTurn> };
  internals.activeByRun.set("starting", {
    session: null,
    pluginAbortController: controller,
  } as ActiveTurn);
  await runtime.cancel("starting");
  expect(controller.signal.aborted).toBe(true);
  expect(internals.activeByRun.get("starting")?.endTurnRequested).toBe(true);
  expect(() => controller.signal.throwIfAborted()).toThrow();
  await expect(runtime.cancel("missing")).rejects.toThrow("not actively executing");
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

test("calls cut off because a typed message superseded the run say the user interrupted them", async () => {
  const { RuntimeTools } = await import("../../src/runtime/tools");
  const runtime = new ComputerRuntime();
  const internals = runtime as unknown as { activeByRun: Map<string, ActiveTurn> };
  const controller = new AbortController();
  const active = {
    runId: "wake",
    session: null,
    pluginAbortController: controller,
    requestSource: "agent",
    subagentType: null,
    readOnly: false,
    pluginRuntimePackages: [],
    pluginNamespaces: [],
    sentMessageCount: 0,
    initialUserStarted: true,
  } as unknown as ActiveTurn;
  internals.activeByRun.set("wake", active);
  const tools = new RuntimeTools(
    {} as any,
    "http://unused.invalid",
    "fixture",
    "/tmp",
    "/tmp"
  ) as any;
  let started!: () => void;
  const calling = new Promise<void>((resolve) => {
    started = resolve;
  });
  tools.callControlPlaneTool = async (
    _turn: unknown,
    _id: string,
    _name: string,
    _args: unknown,
    signal: AbortSignal
  ) => {
    started();
    await new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError"))
      )
    );
  };
  const memory = tools.customTools(active).find((tool: any) => tool.name === "RecallMemory");
  const pending = memory.execute("call", { query: "tea" }, controller.signal);
  await calling;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runtime.cancel("wake", "user_message");
  const error = await pending.catch((caught: Error) => caught);
  expect(error.message).toMatch(
    /^Error: RecallMemory was interrupted by the user after \d+ms before it completed\.$/
  );
  expect(Number(error.message.match(/after (\d+)ms/)![1])).toBeGreaterThanOrEqual(15);
  // A plain Stop keeps the abort as it was.
  const stopped = { ...active, interruptedByUserAt: undefined } as ActiveTurn;
  const plain = new AbortController();
  const stop = tools
    .customTools(stopped)
    .find((tool: any) => tool.name === "RecallMemory")
    .execute("call-2", { query: "tea" }, plain.signal);
  plain.abort();
  expect((await stop.catch((caught: Error) => caught)).message).toBe("The operation was aborted.");
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

test("a parent's message cuts off its worker's turn at once, and the cut-off calls read as interrupted", async () => {
  const runtime = new ComputerRuntime();
  const internals = runtime as unknown as { activeByRun: Map<string, ActiveTurn> };
  const setup = {
    session: null,
    pluginAbortController: new AbortController(),
    initialUserStarted: false,
  } as unknown as ActiveTurn;
  internals.activeByRun.set("worker", setup);
  expect(await runtime.cancel("worker", "parent_message")).toBe(true);
  expect(setup.pluginAbortController!.signal.aborted).toBe(true);
  expect(setup.interruptedByUserAt).toBeNumber();
});
