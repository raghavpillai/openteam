import { test, expect } from "bun:test";
import { BrowserBroker } from "../../src/browser/broker";
const tick = (b: any) => b.schedulePeriodicSync();
const flush = () => new Promise((r) => setTimeout(r, 5));
test("fresh bot detach is independent of old pending reconciliation", async () => {
  const b: any = new BrowserBroker("/tmp/no-io-needed");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  b.reconcile = () => gate;
  tick(b);
  let settled = false;
  const pending = b.detach("fresh-bot").then(() => {
    settled = true;
  });
  await flush();
  const before = settled;
  release();
  await pending;
  expect(before).toBe(true);
});
test("periodic ticks do not build an unbounded queue behind a slow peer", async () => {
  const b: any = new BrowserBroker("/tmp/no-io-needed");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  b.reconcile = async () => {
    calls++;
    await gate;
  };
  for (let i = 0; i < 30; i++) tick(b);
  await flush();
  expect(calls).toBe(1);
  release();
  await b.syncTail;
  await flush();
  expect(calls).toBe(1);
  tick(b);
  await b.syncTail;
  expect(calls).toBe(2);
});
test("owned detach still waits for reconciliation before closing its peer", async () => {
  const b: any = new BrowserBroker("/tmp/no-io-needed");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let closed = false;
  b.reconcile = () => gate;
  b.peers.set("owned", {
    cdp: {
      close() {
        closed = true;
      },
    },
  });
  const pending = b.detach("owned");
  await flush();
  expect(closed).toBe(false);
  release();
  await pending;
  expect(closed).toBe(true);
  expect(b.peers.has("owned")).toBe(false);
});
test("failed periodic reconciliation allows subsequent retries", async () => {
  const b: any = new BrowserBroker("/tmp/no-io-needed");
  let calls = 0;
  b.reconcile = async () => {
    calls++;
    if (calls === 1) throw new Error("temporary IO error");
  };
  tick(b);
  await b.syncTail.catch(() => {});
  await flush();
  tick(b);
  await b.syncTail;
  expect(calls).toBe(2);
});
