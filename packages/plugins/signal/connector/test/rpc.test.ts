import { afterEach, expect, test } from "bun:test";
import { SignalRpc, SignalRpcError } from "../rpc";

const fixture = new URL("./fixture.ts", import.meta.url).pathname;
const processes: SignalRpc[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((rpc) => rpc.close()));
});
function rpc() {
  const value = new SignalRpc([process.execPath, fixture], () => {});
  processes.push(value);
  return value;
}

test("correlates 100 concurrent out-of-order responses", async () => {
  const peer = rpc();
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, value) =>
      peer.request("delay", { value, ms: (99 - value) % 20 })
    )
  );
  expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i));
});

test("upstream errors preserve codes and redact provider error text", async () => {
  try {
    await rpc().request("error");
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(SignalRpcError);
    expect((error as SignalRpcError).code).toBe(-4);
    expect(String(error)).not.toContain("synthetic-provider-secret");
  }
});

test("timed-out responses cannot resolve a later request", async () => {
  const peer = rpc();
  await expect(peer.request("delay", { value: "late", ms: 60 }, 10)).rejects.toThrow("timed out");
  expect(await peer.request("delay", { value: "correct", ms: 90 })).toBe("correct");
});

const wrapper = new URL("./wrapper-fixture.ts", import.meta.url).pathname;
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
