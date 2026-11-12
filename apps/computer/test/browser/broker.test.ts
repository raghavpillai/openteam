import { describe, expect, test } from "bun:test";
import { BrowserBroker, browserCookieInternals, browserStateInternals } from "../../src/browser/broker";
import { stateDigest } from "../../src/browser/origin-state";

describe("computer-scoped browser authority", () => {
  test("keys cookies by name, domain, path, and partition", () => {
    const first = {
      name: "session",
      value: "one",
      domain: ".example.com",
      path: "/",
      partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false },
    };
    expect(browserCookieInternals.cookieKey(first)).toBe(
      browserCookieInternals.cookieKey({ ...first, value: "two" })
    );
    expect(browserCookieInternals.cookieKey(first)).not.toBe(
      browserCookieInternals.cookieKey({ ...first, path: "/admin" })
    );
  });

  test("emits only CDP-settable cookie fields", () => {
    expect(
      browserCookieInternals.cookieParameter({
        name: "session",
        value: "secret",
        domain: ".example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expires: 2_000_000_000,
        size: 128,
        session: false,
      })
    ).toEqual({
      name: "session",
      value: "secret",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expires: 2_000_000_000,
    });
  });

  test("normalizes routable origins and ignores volatile capture timestamps", () => {
    expect(browserStateInternals.originForUrl("https://example.com/path?q=1")).toBe(
      "https://example.com"
    );
    expect(browserStateInternals.originForUrl("chrome://settings")).toBeNull();
    expect(
      browserStateInternals.stateDigest({
        origin: "https://example.com",
        capturedAt: "2026-01-01T00:00:00.000Z",
        localStorage: [["session", "one"]],
      })
    ).toBe(
      browserStateInternals.stateDigest({
        origin: "https://example.com",
        capturedAt: "2026-01-02T00:00:00.000Z",
        localStorage: [["session", "one"]],
      })
    );
  });
});

describe("origin-state work per browser context", () => {

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
});

describe("periodic sync scheduling", () => {
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

test("owned detach releases its connection when unrelated reconciliation stalls", async () => {
  const b: any = new (BrowserBroker as any)("/tmp/no-io-needed", 20);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let closed = false;
  b.reconcile = () => gate;
  b.peers.set("owned", { cdp: { close() { closed = true; } } });
  tick(b);
  const pending = b.detach("owned");
  const outcome = await Promise.race([
    pending.then(() => "released"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 150)),
  ]);
  const closedBeforeSyncRecovered = closed;
  release();
  await pending;
  await b.syncTail;
  expect(outcome).toBe("released");
  expect(closedBeforeSyncRecovered).toBe(true);
  expect(b.peers.has("owned")).toBe(false);
});

});
