import { expect, test } from "bun:test";
import { ComputerRuntime } from "../src/runtime";
import { RuntimeTools } from "../src/runtime/tools";
import { NativeToolExecutor } from "../src/native-tool-executor";

test("run cancellation releases shell waits before waiting for the session to abort", async () => {
  const order: string[] = [];
  const runtime = Object.create(ComputerRuntime.prototype) as any;
  runtime.activeByRun = new Map([
    [
      "owned",
      {
        session: {
          abort: async () => {
            expect(order).toEqual(["shell"]);
            order.push("session");
          },
        },
      },
    ],
  ]);
  runtime.tools = {
    interruptShellWaits: (id: string) => {
      expect(id).toBe("owned");
      order.push("shell");
    },
  };
  await runtime.cancel("owned");
  expect(order).toEqual(["shell", "session"]);
});
