import { expect, test } from "bun:test";
import { BrowserBroker } from "../../src/browser/broker";
import { stateDigest } from "../../src/browser/origin-state";

const origin = "https://example.test";
const state = (value: string) => ({ origin, capturedAt: "2026-01-01", localStorage: [["value", value] as [string, string]] });
const target = (id: string, browserContextId?: string) => ({ targetId: id, sessionId: id, origin, browserContextId });
const peer = (id: string, targets: ReturnType<typeof target>[]) => ({
  botId: id, cdp: { close() {} }, baseline: new Map(),
  targets: new Map(targets.map((value) => [value.targetId, value])),
  originBaselines: new Map([[origin, stateDigest(state("old"))]]),
});
const setup = () => {
  const broker: any = new BrowserBroker("/tmp/no-io-needed");
  broker.refreshTargets = async () => {};
  broker.readCookies = async () => new Map();
  broker.setCookies = async () => {};
  broker.save = async () => {};
  broker.origins.set(origin, state("old"));
  return broker;
};

test("state is read once per context, falling back when the first tab fails", async () => {
  const broker = setup();
  const browser = peer("one", [target("closed"), target("a"), target("b"), target("c", "private")]);
  broker.peers.set("one", browser);
  const reads: string[] = [];
  broker.readOriginState = async (_peer: unknown, tab: ReturnType<typeof target>) => {
    reads.push(tab.targetId); return tab.targetId === "closed" ? null : state("old");
  };
  await broker.reconcile();
  expect(reads).toEqual(["closed", "a", "c"]);
});

test("changed state is not written back to its source and is restored once per destination context", async () => {
  const broker = setup();
  broker.peers.set("source", peer("source", [target("source-a"), target("source-b")]));
  broker.peers.set("destination", peer("destination", [target("a"), target("b"), target("c", "private")]));
  const restored = new Set<string>();
  const writes: string[] = [];
  broker.readOriginState = async (browser: { botId: string }, tab: ReturnType<typeof target>) =>
    state(browser.botId === "source" || restored.has(tab.browserContextId ?? "default") ? "new" : "old");
  broker.writeOriginState = async (browser: { botId: string }, tab: ReturnType<typeof target>) => {
    writes.push(`${browser.botId}/${tab.targetId}`); restored.add(tab.browserContextId ?? "default"); return true;
  };
  await broker.reconcile();
  expect(writes).toEqual(["destination/a", "destination/c"]);
  expect(broker.origins.get(origin).localStorage).toEqual([["value", "new"]]);
});

test("failed and ineffective restores retry another destination tab", async () => {
  const broker = setup();
  broker.peers.set("source", peer("source", [target("source")]));
  broker.peers.set("destination", peer("destination", [target("closed"), target("stale"), target("working")]));
  let restored = false;
  const writes: string[] = [];
  broker.readOriginState = async (browser: { botId: string }) => state(browser.botId === "source" || restored ? "new" : "old");
  broker.writeOriginState = async (_peer: unknown, tab: ReturnType<typeof target>) => {
    writes.push(tab.targetId);
    restored = tab.targetId === "working";
    return tab.targetId !== "closed";
  };
  await broker.reconcile();
  expect(writes).toEqual(["closed", "stale", "working"]);
});
