import { expect, test } from "bun:test";
import { ComputerRuntime } from "../src/runtime";
import { RuntimeTools } from "../src/runtime/tools";
import { NativeToolExecutor } from "../src/native-tool-executor";

test("run cancellation aborts the session, whose signal ends every running wait", async () => {
  const runtime = Object.create(ComputerRuntime.prototype) as any;
  const aborted: string[] = [];
  const controller = new AbortController();
  runtime.activeByRun = new Map([["owned", { pluginAbortController: controller, session: { abort: async () => { aborted.push("session"); } } }]]);
  expect(await runtime.cancel("owned")).toBe(true);
  expect(aborted).toEqual(["session"]);
  expect(controller.signal.aborted).toBe(true);
});
