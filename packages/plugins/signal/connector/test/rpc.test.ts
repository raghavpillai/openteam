import { afterEach, expect, test } from "bun:test";
import { SignalRpc, SignalRpcError } from "../rpc";
import { scopedProcessEnvironment } from "@openteam/plugin-sdk";

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

test("dispatches incoming notifications while commands are in flight", async () => {
  const received: any[] = [];
  const peer = rpc((params) => received.push(params));
  await peer.request("subscribeReceive");
  await peer.request("version");
  expect(received[0].result.envelope.dataMessage.message).toBe("synthetic inbox 🐈");
});

test("preserves UTF-8 split across individual byte writes", async () => {
  expect(await rpc().request("fragmented")).toBe("日本語 🐈 café");
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

test.each([
  "badFrame",
  "bigFrame",
])("rejects pending work after %s and terminates the peer", async (method) => {
  const peer = rpc(undefined, 4096);
  const pending = peer.request("delay", { value: "unreachable", ms: 500 });
  const result = Promise.allSettled([pending, peer.request(method)]);
  expect((await result).every((value) => value.status === "rejected")).toBe(true);
  await peer.exited;
  expect(peer.connected).toBe(false);
});

test("collector storage failures disconnect the process and reject pending commands", async () => {
  const peer = rpc(() => {
    throw new Error("disk full");
  });
  await peer.request("subscribeReceive").catch(() => {});
  await peer.exited;
  await expect(peer.request("version")).rejects.toThrow("collector failed");
});

test("process crashes reject every pending request", async () => {
  const peer = rpc();
  const results = await Promise.allSettled([
    peer.request("delay", { ms: 500 }),
    peer.request("crash"),
  ]);
  expect(results.every((value) => value.status === "rejected")).toBe(true);
  expect(peer.connected).toBe(false);
});

test("stdout EOF with a live peer fails the transport and reaps the child", async () => {
  const peer = rpc();
  await expect(peer.request("closeOutput")).rejects.toThrow("output closed");
  await peer.exited;
  expect(peer.connected).toBe(false);
  expect(peer.signalCode).toBe("SIGTERM");
});

test("closed process input fails the transport and reaps the child", async () => {
  const peer = rpc();
  await peer.request("closeInput");
  await expect(peer.request("version", {}, 3000)).rejects.toThrow("input closed");
  await peer.exited;
  expect(peer.connected).toBe(false);
  // Closing stdin can make the fixture exit before SIGTERM arrives. Either path must reap it.
  expect(peer.exitCode !== null || peer.signalCode !== null).toBe(true);
}, 5000);

test("invalid-frame peers that ignore SIGTERM receive bounded SIGKILL escalation", async () => {
  const peer = rpc();
  await expect(peer.request("ignoreTermAndBreakFrame")).rejects.toThrow("invalid frame");
  await peer.exited;
  expect(peer.connected).toBe(false);
  expect(peer.signalCode).toBe("SIGKILL");
}, 5000);

test("missing executable has an actionable error without echoing configuration", () => {
  expect(() => new SignalRpc(["/does-not-exist/synthetic-secret"], () => {})).toThrow(
    "Could not launch signal-cli"
  );
});

test("child environment excludes provider credentials and inherited Signal configuration", () => {
  expect(
    scopedProcessEnvironment(
      {
        PATH: "/bin",
        HOME: "/tmp/test",
        OPENAI_API_KEY: "synthetic",
        SIGNAL_CLI_CONFIG: "/private/config",
        GOOGLE_ACCESS_TOKEN: "synthetic",
      },
      { JAVA_HOME: "/test/jre" }
    )
  ).toEqual({ PATH: "/bin", HOME: "/tmp/test", JAVA_HOME: "/test/jre" });
});
