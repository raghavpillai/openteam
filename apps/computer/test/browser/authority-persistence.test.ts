import { afterEach, expect, test } from "bun:test";
import { createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserBroker } from "../../src/browser/broker";
import type { BrowserOriginState } from "../../src/browser/origin-state";
import type { BrowserCookie } from "../../src/browser/cookies";

interface Persistence {
  load(): Promise<void>;
  save(): Promise<void>;
  origins: Map<string, BrowserOriginState>;
  cookies: Map<string, BrowserCookie>;
}
let home: string | undefined;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});
const fixture = async () => {
  home = await mkdtemp(join(tmpdir(), "openteam-authority-persistence-"));
  const broker = new BrowserBroker(home) as unknown as Persistence;
  await broker.load();
  return {
    broker,
    directory: join(home, ".openteam"),
    path: join(home, ".openteam", "browser-authority.json.enc"),
  };
};
const origin = "https://fixture.invalid";
const cookie: BrowserCookie = {
  name: "persistent",
  value: "kept",
  domain: "fixture.invalid",
  path: "/",
  expires: 2_000_000_000,
};

const decrypt = (envelope: { iv: string; tag: string; data: string }, key: Buffer) => {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
};
const partsOf = async (directory: string) => {
  const parts = join(directory, "browser-authority.parts");
  const names = (await readdir(parts).catch(() => [])).sort();
  return new Map(
    await Promise.all(names.map(async (name) => [name, (await stat(join(parts, name))).mtimeMs] as const))
  );
};

test("encrypted saves preserve the envelope across base64 chunk boundaries", async () => {
  const { broker, directory, path } = await fixture();
  broker.cookies.set("persistent", cookie);
  broker.cookies.set("session", { ...cookie, name: "session", expires: -1 });
  const key = await readFile(join(directory, "browser-authority.key"));
  let previousIv = "";
  for (const size of [0, 786431, 786432, 786433, 1572881]) {
    const payload = "x".repeat(size) + "😀測試é";
    const state: BrowserOriginState = {
      origin,
      capturedAt: "2026-10-19",
      localStorage: [["payload", payload]],
    };
    broker.origins.set(origin, state);
    await broker.save();
    const envelope = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(envelope)).toEqual(["iv", "tag", "data"]);
    expect(envelope.iv).not.toBe(previousIv);
    previousIv = envelope.iv;
    const index = JSON.parse(decrypt(envelope, key));
    expect(index.version).toBe(3);
    expect(index.cookies).toEqual([cookie]);
    // Large values live in their own encrypted part, small ones stay inline.
    const parts = [...(await partsOf(directory)).keys()];
    const partPayloads = await Promise.all(
      parts.map(async (name) =>
        JSON.parse(decrypt(JSON.parse(await readFile(join(directory, "browser-authority.parts", name), "utf8")), key))
      )
    );
    if (size < 16 * 1024) {
      expect(index.origins[origin]).toEqual(state);
    } else {
      expect(index.origins[origin].localStorage[0][1]).toEqual({ $part: expect.any(String) });
      expect(partPayloads).toContain(payload);
    }
    for (const name of parts) {
      expect((await stat(join(directory, "browser-authority.parts", name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const loaded = new BrowserBroker(home) as unknown as Persistence;
    await loaded.load();
    expect(loaded.origins.get(origin)).toEqual(state);
    expect([...loaded.cookies.values()]).toEqual([cookie]);
  }
  expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
});

test("a small idle change rewrites only the index and leaves large stored data untouched", async () => {
  const { broker, directory, path } = await fixture();
  const entry = (index: number, body: string) => ({
    request: { url: `${origin}/asset-${index}.js`, method: "GET", headers: [] },
    response: { status: 200, statusText: "OK", headers: [], body },
  });
  const state = (rotating: string, firstBody = "A".repeat(200_000)): BrowserOriginState => ({
    origin,
    capturedAt: rotating,
    localStorage: [["module-cache", "m".repeat(300_000)], ["session-id", rotating]],
    indexedDb: [{ name: "app", version: 1, stores: [{ name: "s", records: [{ key: 1, value: "v".repeat(40_000) }] }] }],
    cacheStorage: [{ name: "precache", entries: [entry(0, firstBody), entry(1, "B".repeat(200_000))] }],
    serviceWorkers: [{ scope: `${origin}/`, scriptURL: `${origin}/sw.js` }],
  });
  broker.cookies.set("persistent", cookie);
  broker.origins.set(origin, state("first"));
  await broker.save();
  const parts = await partsOf(directory);
  expect(parts.size).toBe(4);
  const index = await readFile(path);
  expect(index.length).toBeLessThan(4096);

  // A rotating session key and a rolling cookie expiry.
  broker.origins.set(origin, state("second"));
  broker.cookies.set("persistent", { ...cookie, expires: cookie.expires! + 60 });
  await broker.save();
  expect(await partsOf(directory)).toEqual(parts);
  expect(await readFile(path)).not.toEqual(index);
  let loaded = new BrowserBroker(home) as unknown as Persistence;
  await loaded.load();
  expect(loaded.origins.get(origin)).toEqual(state("second"));
  expect([...loaded.cookies.values()]).toEqual([{ ...cookie, expires: cookie.expires! + 60 }]);

  // One changed cache entry adds one part; the superseded part stays for one
  // more generation so a snapshot taken mid-save still restores.
  broker.origins.set(origin, state("third", "C".repeat(200_000)));
  await broker.save();
  const changed = await partsOf(directory);
  expect([...changed.keys()].filter((name) => !parts.has(name))).toHaveLength(1);
  expect(changed.size).toBe(5);
  broker.origins.set(origin, state("fourth", "C".repeat(200_000)));
  await broker.save();
  const pruned = await partsOf(directory);
  expect(pruned.size).toBe(4);
  for (const [name, mtime] of pruned) expect(changed.get(name)).toBe(mtime);
  loaded = new BrowserBroker(home) as unknown as Persistence;
  await loaded.load();
  expect(loaded.origins.get(origin)).toEqual(state("fourth", "C".repeat(200_000)));
});

test("a missing or altered part drops only that storage area on restore", async () => {
  const { broker, directory } = await fixture();
  const state: BrowserOriginState = {
    origin,
    capturedAt: "2026-10-26",
    localStorage: [["token", "signed-in"], ["bundle", "b".repeat(50_000)]],
    cacheStorage: [{ name: "precache", entries: [{ body: "c".repeat(50_000) }] }],
    serviceWorkers: [{ scope: `${origin}/`, scriptURL: `${origin}/sw.js` }],
  };
  broker.origins.set(origin, state);
  await broker.save();
  const partsDirectory = join(directory, "browser-authority.parts");
  const key = await readFile(join(directory, "browser-authority.key"));
  const names = [...(await partsOf(directory)).keys()];
  expect(names).toHaveLength(2);
  const contents = await Promise.all(
    names.map(async (name) => decrypt(JSON.parse(await readFile(join(partsDirectory, name), "utf8")), key))
  );
  const cachePart = names[contents.findIndex((value) => value.includes("ccc"))]!;
  const bundlePart = names.find((name) => name !== cachePart)!;
  await rm(join(partsDirectory, cachePart));
  let loaded = new BrowserBroker(home) as unknown as Persistence;
  await loaded.load();
  expect(loaded.origins.get(origin)).toEqual({ ...state, cacheStorage: undefined } as unknown as BrowserOriginState);
  expect("cacheStorage" in loaded.origins.get(origin)!).toBe(false);

  // A valid part under another part's name is rejected too.
  await broker.save();
  await writeFile(join(partsDirectory, cachePart), await readFile(join(partsDirectory, bundlePart)));
  loaded = new BrowserBroker(home) as unknown as Persistence;
  await loaded.load();
  expect(loaded.origins.get(origin)?.localStorage).toEqual(state.localStorage);
  expect("cacheStorage" in loaded.origins.get(origin)!).toBe(false);
});

test("streamed saves preserve multiple origins and reject tampered ciphertext before loading state", async () => {
  const { broker, path } = await fixture();
  for (let i = 0; i < 4; i++) {
    const site = `https://site-${i}.invalid`;
    broker.origins.set(site, {
      origin: site,
      capturedAt: "2026-10-20",
      localStorage: [["value", "x".repeat(16383) + "😀".repeat(20000)]],
      indexedDb: [{ records: [{ value: { t: "BigInt", v: "12345678901234567890" } }] }],
      cacheStorage: [{ body: "A".repeat(700001 + i) }],
      serviceWorkers: [{ scope: site + "/", scriptURL: site + "/sw.js" }],
    });
  }
  await broker.save();
  const loaded = new BrowserBroker(home) as unknown as Persistence;
  await loaded.load();
  expect([...loaded.origins]).toEqual([...broker.origins]);
  const packed = JSON.parse(await readFile(path, "utf8"));
  packed.data = (packed.data[0] === "A" ? "B" : "A") + packed.data.slice(1);
  await writeFile(path, JSON.stringify(packed));
  const tampered = new BrowserBroker(home) as unknown as Persistence;
  await tampered.load();
  expect(tampered.origins.size).toBe(0);
  expect(tampered.cookies.size).toBe(0);
});

test("a mid-stream failure preserves the last save, cleans staging, and allows a later save", async () => {
  const { broker, path, directory } = await fixture();
  broker.cookies.set("persistent", cookie);
  await broker.save();
  const previous = await readFile(path);
  const badState: BrowserOriginState = {
    origin,
    capturedAt: "2026-10-20",
    localStorage: [["large", "x".repeat(300000)]],
  };
  badState.cycle = badState;
  broker.origins.set(origin, badState);
  await expect(broker.save()).rejects.toThrow("Circular browser state");
  expect(await readFile(path)).toEqual(previous);
  expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  broker.origins.clear();
  await broker.save();
  const loaded = new BrowserBroker(home) as unknown as Persistence;
  await loaded.load();
  expect([...loaded.cookies.values()]).toEqual([cookie]);
});

test("loads reordered legacy envelopes and rejects truncated or invalid authentication tags", async () => {
  const { broker, path } = await fixture();
  broker.cookies.set("persistent", cookie);
  await broker.save();
  const packed = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ data: packed.data, tag: packed.tag, iv: packed.iv }, null, 2));
  const legacy = new BrowserBroker(home) as unknown as Persistence;
  await legacy.load();
  expect([...legacy.cookies.values()]).toEqual([cookie]);
  const canonical = JSON.stringify(packed);
  for (const compatible of [
    canonical + "\n",
    JSON.stringify({ ...packed, extra: "ignored by legacy readers" }),
  ]) {
    await writeFile(path, compatible);
    const loaded = new BrowserBroker(home) as unknown as Persistence;
    await loaded.load();
    expect([...loaded.cookies.values()]).toEqual([cookie]);
  }
  for (const bad of [
    canonical.slice(0, -1),
    JSON.stringify({ ...packed, tag: Buffer.alloc(16).toString("base64") }),
  ]) {
    await writeFile(path, bad);
    const loaded = new BrowserBroker(home) as unknown as Persistence;
    await loaded.load();
    expect(loaded.cookies.size).toBe(0);
    expect(loaded.origins.size).toBe(0);
  }
});

test("overlapping saves publish the latest snapshot after an in-flight older save", async () => {
  const { broker } = await fixture();
  const internal = broker as Persistence & { key(): Promise<Buffer> };
  const originalKey = internal.key.bind(internal);
  let started!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  internal.key = async () => {
    if (first) {
      first = false;
      started();
      await gate;
    }
    return originalKey();
  };
  broker.origins.set(origin, { origin, capturedAt: "old", localStorage: [["value", "old"]] });
  const older = broker.save();
  await waiting;
  broker.origins.set(origin, { origin, capturedAt: "new", localStorage: [["value", "new"]] });
  const newer = broker.save();
  release();
  await Promise.all([older, newer]);
  const loaded = new BrowserBroker(home) as unknown as Persistence;
  await loaded.load();
  expect(loaded.origins.get(origin)?.localStorage).toEqual([["value", "new"]]);
});

test("saves with unchanged state keep the encrypted file, and a changed key or state rewrites it", async () => {
  const { broker, directory, path } = await fixture();
  broker.cookies.set("persistent", cookie);
  broker.origins.set(origin, { origin, capturedAt: "2026-10-22", localStorage: [["value", "kept"]] });
  await broker.save();
  const saved = await readFile(path);
  const savedAt = (await stat(path)).mtimeMs;
  broker.cookies.set("session", { ...cookie, name: "session", expires: -1 });
  await broker.save();
  expect(await readFile(path)).toEqual(saved);
  expect((await stat(path)).mtimeMs).toBe(savedAt);
  const reloaded = new BrowserBroker(home) as unknown as Persistence;
  await reloaded.load();
  await reloaded.save();
  expect(await readFile(path)).toEqual(saved);
  reloaded.origins.set(origin, { origin, capturedAt: "2026-10-22", localStorage: [["value", "changed"]] });
  await reloaded.save();
  const changed = await readFile(path);
  expect(changed).not.toEqual(saved);
  await rm(join(directory, "browser-authority.key"));
  await reloaded.save();
  expect(await readFile(path)).not.toEqual(changed);
  const rekeyed = new BrowserBroker(home) as unknown as Persistence;
  await rekeyed.load();
  expect(rekeyed.origins.get(origin)?.localStorage).toEqual([["value", "changed"]]);
  await rm(path);
  await rekeyed.save();
  expect(await stat(path)).toBeTruthy();
});
