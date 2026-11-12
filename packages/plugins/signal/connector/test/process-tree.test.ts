import { expect, test } from "bun:test";
import { SignalRpc } from "../rpc";

const wrapper = new URL("./wrapper-fixture.ts", import.meta.url).pathname;
const fixture = new URL("./fixture.ts", import.meta.url).pathname;
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function expectReaped(pid: number) {
  for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(10);
  expect(alive(pid)).toBe(false);
}
function cleanup(pid?: number) {
  if (pid && alive(pid)) process.kill(pid, "SIGKILL");
}

test("wrapper exit fails pending requests promptly and reaps descendants retaining pipes", async () => {
  const rpc = new SignalRpc([process.execPath, wrapper], () => {});
  let pid: number | undefined;
  try {
    pid = (await rpc.request("descendantPid")).pid;
    await expect(rpc.request("exitWrapper", {}, 1000)).rejects.toThrow("disconnected");
    expect(
      await Promise.race([rpc.exited.then(() => true), Bun.sleep(2500).then(() => false)])
    ).toBe(true);
    expect(rpc.exitCode).toBe(0);
    await expectReaped(pid!);
  } finally {
    cleanup(pid);
    await rpc.close();
  }
}, 5000);
