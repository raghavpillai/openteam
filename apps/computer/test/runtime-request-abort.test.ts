import { expect, test } from "bun:test";
import { ComputerRuntime } from "../src/runtime";
import type { ComputerTurnRequest } from "@openteam/contracts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
};
const request = {
  runId: "run", contextSessionId: "context", botId: "bot", model: "openai/test", instructions: "test",
} as ComputerTurnRequest;
const runtimeFixture = () => {
  const runtime = Object.create(ComputerRuntime.prototype) as any;
  Object.assign(runtime, {
    activeByRun: new Map(), activeByContext: new Map(), start: async () => {},
    cleanup: async (active: any) => {
      runtime.activeByRun.delete(active.runId);
      runtime.activeByContext.delete(active.contextSessionId);
    },
  });
  return runtime;
};

test("an already-expired request never starts runtime initialization", async () => {
  const runtime = runtimeFixture();
  const controller = new AbortController();
  controller.abort(new Error("HTTP request expired"));
  let starts = 0;
  runtime.start = async () => { starts++; };
  await expect(runtime.run(request, controller.signal)).rejects.toThrow("HTTP request expired");
  expect(starts).toBe(0);
});

test("a request aborted during cold startup cannot reserve or start a turn later", async () => {
  const runtime = runtimeFixture();
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  let admissions = 0;
  runtime.start = async () => { entered.resolve(); await release.promise; };
  runtime.resolveModel = () => { admissions++; throw new Error("admitted after abort"); };
  const outcome = runtime.run(request, controller.signal).catch((error: unknown) => error);
  await entered.promise;
  controller.abort(new Error("HTTP request expired"));
  release.resolve();
  expect(String(await outcome)).toContain("HTTP request expired");
  expect(admissions).toBe(0);
  expect(runtime.activeByRun.size).toBe(0);
});

test("a request aborted during authentication releases its reserved context before tool setup", async () => {
  const runtime = runtimeFixture();
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  let toolSetups = 0;
  runtime.resolveModel = () => {};
  runtime.modelRuntime = { checkAuth: async () => { entered.resolve(); await release.promise; return true; } };
  runtime.tools = { messagesAvailable: async () => { toolSetups++; throw new Error("continued after abort"); } };
  const outcome = runtime.run(request, controller.signal).catch((error: unknown) => error);
  await entered.promise;
  controller.abort(new Error("HTTP request expired"));
  release.resolve();
  expect(String(await outcome)).toContain("HTTP request expired");
  expect(toolSetups).toBe(0);
  expect(runtime.activeByContext.size).toBe(0);
});
