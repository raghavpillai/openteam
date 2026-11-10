import { expect, test } from "bun:test";
import { SignalRpc } from "../rpc";
import { SignalService } from "../service";
import { MessageStore } from "../store";

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

test("explicit close is bounded when a wrapper's runtime retains output pipes", async () => {
  const rpc = new SignalRpc([process.execPath, wrapper], () => {});
  let pid: number | undefined;
  try {
    pid = (await rpc.request("descendantPid")).pid;
    expect(
      await Promise.race([rpc.close().then(() => true), Bun.sleep(2500).then(() => false)])
    ).toBe(true);
    expect(rpc.connected).toBe(false);
    await expectReaped(pid!);
  } finally {
    cleanup(pid);
    await rpc.close();
  }
}, 5000);

test("automatic recovery resumes after a wrapper exits with a live runtime descendant", async () => {
  let first!: SignalRpc;
  let launches = 0;
  let pid: number | undefined;
  const service = new SignalService(
    new MessageStore(":memory:"),
    (receive) => {
      launches++;
      const rpc = new SignalRpc([process.execPath, launches === 1 ? wrapper : fixture], receive);
      if (launches === 1) first = rpc;
      return rpc;
    },
    10
  );
  try {
    await service.connect();
    pid = (await first.request("descendantPid")).pid;
    await first.request("exitWrapper").catch(() => {});
    for (let i = 0; i < 150 && launches < 2; i++) await Bun.sleep(20);
    expect(launches).toBe(2);
    expect(await service.status()).toMatchObject({ connected: true, linked: true });
    await expectReaped(pid!);
  } finally {
    cleanup(pid);
    await service.close();
  }
}, 6000);
