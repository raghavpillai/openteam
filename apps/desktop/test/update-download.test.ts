import { expect, test } from "bun:test";
import { DesktopDownloadGate } from "../src/main/update-download";

test("10,000 native IPC requests share setup and download across renderer lifetimes", async () => {
  const gate = new DesktopDownloadGate();
  let calls = 0;
  let finish!: () => void;
  const run = () => {
    calls++;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  const requests = Array.from({ length: 10_000 }, () => gate.run("0.0.19", "0.0.19", run));
  await Promise.resolve();
  expect(calls).toBe(1);
  // A reloaded renderer may see a newer feed, but cannot replace the in-flight target.
  expect(() => gate.run("0.1.0", "0.1.0", run)).toThrow("release changed");
  const joined = gate.run("0.0.19", "0.1.0", run);
  finish();
  await Promise.all([...requests, joined]);
  expect(calls).toBe(1);
});

test("a failed native download releases ownership for an explicit retry", async () => {
  const gate = new DesktopDownloadGate();
  let calls = 0;
  const fail = async () => {
    calls++;
    throw new Error("Signature verification failed");
  };
  const results = await Promise.allSettled(
    Array.from({ length: 100 }, () => gate.run("0.0.19", "0.0.19", fail))
  );
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(calls).toBe(1);
  await gate.run("0.0.19", "0.0.19", async () => {
    calls++;
  });
  expect(calls).toBe(2);
});
