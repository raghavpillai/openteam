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

test("encrypted saves preserve the legacy envelope across base64 chunk boundaries", async () => {
  const { broker, directory, path } = await fixture();
  broker.cookies.set("persistent", cookie);
  broker.cookies.set("session", { ...cookie, name: "session", expires: -1 });
  const key = await readFile(join(directory, "browser-authority.key"));
  let previousIv = "";
  for (const size of [0, 786431, 786432, 786433, 1572881]) {
    const state: BrowserOriginState = {
      origin,
      capturedAt: "2026-10-19",
      localStorage: [["payload", "x".repeat(size) + "😀測試é"]],
    };
    broker.origins.set(origin, state);
    await broker.save();
    const envelope = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(envelope)).toEqual(["iv", "tag", "data"]);
    expect(envelope.iv).not.toBe(previousIv);
    previousIv = envelope.iv;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    expect(plaintext).toBe(
      JSON.stringify({ version: 2, cookies: [cookie], origins: { [origin]: state } })
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const loaded = new BrowserBroker(home) as unknown as Persistence;
    await loaded.load();
    expect(loaded.origins.get(origin)).toEqual(state);
    expect([...loaded.cookies.values()]).toEqual([cookie]);
  }
  expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
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
