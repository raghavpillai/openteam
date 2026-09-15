import { expect, test } from "bun:test";
import type { BotMemoryList } from "@openteam/contracts";
import { createMemoryView, type MemoryViewState } from "../src/renderer/lib/memory-view";
import { refreshMemoryViews, subscribeMemoryRefresh } from "../src/renderer/lib/memory-events";

const list = (content = ""): BotMemoryList => ({
  botId: "bot",
  memories: content ? [{ id: "fact", content, createdAt: 0, kind: "profile" }] : [],
  total: content ? 1 : 0,
  limit: 1000,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a delayed pre-delete list cannot restore deleted facts; queued changes cause a fresh read", async () => {
  const old = deferred<BotMemoryList>();
  let reads = 0;
  const states: MemoryViewState[] = [];
  const view = createMemoryView({
    load: () => (++reads === 1 ? old.promise : Promise.resolve(list())),
    remove: async () => list(),
    change: (s) => states.push(s),
  });
  void view.refresh();
  expect(await view.remove("fact")).toBe(true);
  old.resolve(list("stale fact"));
  await tick();
  expect(reads).toBe(2);
  expect(states.some((s) => s.data?.memories[0]?.content === "stale fact")).toBe(false);
  expect(states.at(-1)?.data?.total).toBe(0);
  view.stop();
});

test("multiple refreshes are serialized and coalesced", async () => {
  const first = deferred<BotMemoryList>();
  let reads = 0;
  const view = createMemoryView({
    load: () => (++reads === 1 ? first.promise : Promise.resolve(list("new"))),
    remove: async () => list(),
    change: () => {},
  });
  void view.refresh();
  void view.refresh();
  void view.refresh();
  expect(reads).toBe(1);
  first.resolve(list());
  await tick();
  expect(reads).toBe(2);
  view.stop();
});

test("failed deletion preserves data and error until an explicit retry succeeds", async () => {
  let fail = true;
  const states: MemoryViewState[] = [];
  const view = createMemoryView({
    load: async () => list("keep me"),
    remove: async () => {
      if (fail) throw new Error("offline");
      return list();
    },
    change: (s) => states.push(s),
  });
  await view.refresh();
  expect(await view.remove("fact")).toBe(false);
  await tick();
  expect(states.at(-1)?.data?.total).toBe(1);
  expect(states.at(-1)?.error).toContain("Could not delete");
  fail = false;
  expect(await view.remove("fact")).toBe(true);
  view.stop();
  expect(states.at(-1)?.error).toBeNull();
});

test("closing a view stops late updates and blocks duplicate mutations", async () => {
  const pending = deferred<BotMemoryList>();
  let writes = 0;
  const states: MemoryViewState[] = [];
  const view = createMemoryView({
    load: async () => list(),
    remove: () => {
      writes++;
      return pending.promise;
    },
    change: (s) => states.push(s),
  });
  const first = view.remove();
  expect(await view.remove()).toBe(false);
  expect(writes).toBe(1);
  view.stop();
  const count = states.length;
  pending.resolve(list());
  expect(await first).toBe(false);
  expect(states.length).toBe(count);
});

test("live memory invalidations identify the bot; reconnect and snapshot recovery refresh open views", () => {
  const seen: (string | null)[] = [];
  const off = subscribeMemoryRefresh((id) => seen.push(id));
  const base = { sequence: "1", entityId: "bot", payload: {}, createdAt: new Date().toISOString() };
  refreshMemoryViews({ ...base, topic: "memory.changed" });
  refreshMemoryViews({ ...base, topic: "message.created" });
  refreshMemoryViews();
  refreshMemoryViews({ ...base, topic: "snapshot.required" });
  off();
  refreshMemoryViews();
  expect(seen).toEqual(["bot", null, null]);
});
