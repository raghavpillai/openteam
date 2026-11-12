import { afterEach, expect, test } from "bun:test";
import { SignalRpc, SignalRpcError } from "../rpc";

const fixture = new URL("./fixture.ts", import.meta.url).pathname;
const processes: SignalRpc[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((rpc) => rpc.close()));
});
function rpc(receive = (_: any) => {}, maxFrameBytes?: number) {
  const value = new SignalRpc([process.execPath, fixture], receive, { maxFrameBytes });
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
