import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { waitForProcessExit } from "../src/screen/processes";

test("timed out shutdown waits release only their own listeners", async () => {
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const unrelated = () => {};
  child.on("exit", unrelated);
  try {
    for (let i = 0; i < 12; i++) await waitForProcessExit([child], 1);
    expect(child.listeners("exit")).toEqual([unrelated]);
    const pending = waitForProcessExit([child, child], 2_000);
    child.kill("SIGKILL");
    await pending;
    expect(child.listeners("exit")).toEqual([unrelated]);
  } finally {
    child.kill("SIGKILL");
    child.removeListener("exit", unrelated);
  }
});

test("overlapping waits each finish and detach on process exit", async () => {
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    const waits = [waitForProcessExit([child], 2_000), waitForProcessExit([child], 2_000)];
    child.kill("SIGKILL");
    await Promise.all(waits);
    expect(child.listenerCount("exit")).toBe(0);
    await waitForProcessExit([child], 2_000);
    expect(child.listenerCount("exit")).toBe(0);
  } finally {
    child.kill("SIGKILL");
  }
});
