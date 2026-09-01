import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

interface BrowserCookie extends JsonObject {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  session?: boolean;
  partitionKey?: JsonObject;
  partitionKeyOpaque?: boolean;
}

interface Peer {
  botId: string;
  port: number;
  profileDirectory: string;
  cdp: CdpConnection;
  baseline: Map<string, BrowserCookie>;
  targets: Map<string, BrowserTarget>;
  originBaselines: Map<string, string>;
}

interface BrowserTarget {
  targetId: string;
  sessionId: string;
  origin: string;
}

interface BrowserOriginState extends JsonObject {
  origin: string;
  capturedAt: string;
  localStorage?: Array<[string, string]>;
  indexedDb?: unknown[];
  cacheStorage?: unknown[];
  serviceWorkers?: unknown[];
}

const cookieKey = (cookie: BrowserCookie): string =>
  [cookie.name, cookie.domain, cookie.path, JSON.stringify(cookie.partitionKey ?? null)].join("\0");

const cookieParameter = (cookie: BrowserCookie): JsonObject => {
  const result: JsonObject = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
  };
  for (const key of [
    "secure",
    "httpOnly",
    "sameSite",
    "priority",
    "sameParty",
    "sourceScheme",
    "sourcePort",
  ]) {
    if (cookie[key] !== undefined) result[key] = cookie[key];
  }
  if (typeof cookie.expires === "number" && cookie.expires > 0) result.expires = cookie.expires;
  if (cookie.partitionKey && !cookie.partitionKeyOpaque) result.partitionKey = cookie.partitionKey;
  return result;
};

const asCookie = (value: unknown): BrowserCookie | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as JsonObject;
  if (
    typeof raw.name !== "string" ||
    typeof raw.value !== "string" ||
    typeof raw.domain !== "string" ||
    typeof raw.path !== "string"
  ) {
    return null;
  }
  return raw as BrowserCookie;
};

const cookieMap = (values: unknown[]): Map<string, BrowserCookie> => {
  const result = new Map<string, BrowserCookie>();
  for (const value of values) {
    const cookie = asCookie(value);
    if (cookie) result.set(cookieKey(cookie), cookie);
  }
  return result;
};

const BROWSER_STATE_EXPORT_EXPRESSION = String.raw`(async () => {
  const bytesToBase64 = (bytes) => {
    let value = "";
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let index = 0; index < view.length; index += 0x8000) {
      value += String.fromCharCode(...view.subarray(index, index + 0x8000));
    }
    return btoa(value);
  };
  const pack = async (root) => {
    const seen = new WeakMap();
    let nextId = 1;
    const visit = async (value) => {
      if (value === undefined) return { t: "Undefined" };
      if (typeof value === "bigint") return { t: "BigInt", v: String(value) };
      if (typeof value === "number" && !Number.isFinite(value)) return { t: "Number", v: String(value) };
      if (value === null || typeof value !== "object") return value;
      const prior = seen.get(value);
      if (prior) return { r: prior };
      const id = nextId++;
      seen.set(value, id);
      if (value instanceof Date) return { i: id, t: "Date", v: value.toISOString() };
      if (value instanceof RegExp) return { i: id, t: "RegExp", v: value.source, f: value.flags };
      if (value instanceof Blob) {
        return { i: id, t: "Blob", m: value.type, v: bytesToBase64(await value.arrayBuffer()) };
      }
      if (value instanceof ArrayBuffer) return { i: id, t: "ArrayBuffer", v: bytesToBase64(value) };
      if (ArrayBuffer.isView(value)) {
        return {
          i: id,
          t: "TypedArray",
          n: value.constructor.name,
          v: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        };
      }
      if (value instanceof Map) {
        return { i: id, t: "Map", v: await Promise.all([...value].map(async ([key, item]) => [await visit(key), await visit(item)])) };
      }
      if (value instanceof Set) {
        return { i: id, t: "Set", v: await Promise.all([...value].map(visit)) };
      }
      if (Array.isArray(value)) return { i: id, t: "Array", v: await Promise.all(value.map(visit)) };
      const entries = [];
      for (const key of Object.keys(value)) entries.push([key, await visit(value[key])]);
      return { i: id, t: "Object", v: entries };
    };
    return visit(root);
  };
  const request = (value) => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error || new Error("IndexedDB request failed"));
    value.onblocked = () => reject(new Error("IndexedDB request blocked"));
  });
  const state = { origin: location.origin, capturedAt: new Date().toISOString() };
  try {
    state.localStorage = Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key) || ""]);
  } catch {}
  try {
    const infos = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    state.indexedDb = [];
    for (const info of infos) {
      if (!info.name) continue;
      const database = await request(indexedDB.open(info.name));
      const stores = [];
      for (const storeName of [...database.objectStoreNames]) {
        const transaction = database.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const values = await request(store.getAll());
        const keys = await request(store.getAllKeys());
        stores.push({
          name: storeName,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: [...store.indexNames].map((name) => {
            const index = store.index(name);
            return { name, keyPath: index.keyPath, multiEntry: index.multiEntry, unique: index.unique };
          }),
          records: await Promise.all(values.map(async (value, index) => ({
            key: await pack(keys[index]),
            value: await pack(value),
          }))),
        });
      }
      state.indexedDb.push({ name: info.name, version: database.version, stores });
      database.close();
    }
  } catch {}
  try {
    state.cacheStorage = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const entries = [];
      for (const cachedRequest of await cache.keys()) {
        const response = await cache.match(cachedRequest);
        if (!response) continue;
        entries.push({
          request: { url: cachedRequest.url, method: cachedRequest.method, headers: [...cachedRequest.headers] },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers],
            body: bytesToBase64(await response.clone().arrayBuffer()),
          },
        });
      }
      state.cacheStorage.push({ name, entries });
    }
  } catch {}
  try {
    state.serviceWorkers = (await navigator.serviceWorker.getRegistrations()).flatMap((registration) => {
      const worker = registration.active || registration.waiting || registration.installing;
      return worker ? [{ scope: registration.scope, scriptURL: worker.scriptURL, updateViaCache: registration.updateViaCache }] : [];
    });
  } catch {}
  return state;
})()`;

const BROWSER_STATE_IMPORT_FUNCTION = String.raw`async (state) => {
  const base64ToBytes = (value) => {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return bytes;
  };
  const unpack = (root) => {
    const refs = new Map();
    const visit = (value) => {
      if (value === null || typeof value !== "object") return value;
      if ("r" in value) return refs.get(value.r);
      if (value.t === "Undefined") return undefined;
      if (value.t === "BigInt") return BigInt(value.v);
      if (value.t === "Number") return Number(value.v);
      let result;
      if (value.t === "Date") result = new Date(value.v);
      else if (value.t === "RegExp") result = new RegExp(value.v, value.f);
      else if (value.t === "Blob") result = new Blob([base64ToBytes(value.v)], { type: value.m });
      else if (value.t === "ArrayBuffer") result = base64ToBytes(value.v).buffer;
      else if (value.t === "TypedArray") {
        const bytes = base64ToBytes(value.v);
        const constructors = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
        const Constructor = constructors[value.n] || Uint8Array;
        result = value.n === "DataView" ? new DataView(bytes.buffer) : new Constructor(bytes.buffer);
      } else if (value.t === "Map") result = new Map();
      else if (value.t === "Set") result = new Set();
      else if (value.t === "Array") result = [];
      else result = {};
      if (value.i) refs.set(value.i, result);
      if (value.t === "Map") for (const [key, item] of value.v) result.set(visit(key), visit(item));
      else if (value.t === "Set") for (const item of value.v) result.add(visit(item));
      else if (value.t === "Array") for (const item of value.v) result.push(visit(item));
      else if (value.t === "Object") for (const [key, item] of value.v) result[key] = visit(item);
      return result;
    };
    return visit(root);
  };
  const request = (value) => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error || new Error("IndexedDB request failed"));
    value.onblocked = () => reject(new Error("IndexedDB request blocked"));
  });
  if (Array.isArray(state.localStorage)) {
    localStorage.clear();
    for (const [key, value] of state.localStorage) localStorage.setItem(key, value);
  }
  if (Array.isArray(state.indexedDb)) {
    const desiredDatabases = new Set(state.indexedDb.map((database) => database.name));
    if (typeof indexedDB.databases === "function") {
      for (const database of await indexedDB.databases()) {
        if (database.name && !desiredDatabases.has(database.name)) await request(indexedDB.deleteDatabase(database.name)).catch(() => undefined);
      }
    }
    for (const snapshot of state.indexedDb) {
      let current = await request(indexedDB.open(snapshot.name));
      const desiredStores = new Set(snapshot.stores.map((store) => store.name));
      const schemaDiffers = snapshot.stores.some((definition) => {
        if (!current.objectStoreNames.contains(definition.name)) return true;
        const transaction = current.transaction(definition.name, "readonly");
        const store = transaction.objectStore(definition.name);
        if (JSON.stringify(store.keyPath) !== JSON.stringify(definition.keyPath) || store.autoIncrement !== definition.autoIncrement) return true;
        const desiredIndexes = new Set((definition.indexes || []).map((index) => index.name));
        return [...store.indexNames].some((name) => !desiredIndexes.has(name)) ||
          (definition.indexes || []).some((index) => {
            if (!store.indexNames.contains(index.name)) return true;
            const existing = store.index(index.name);
            return JSON.stringify(existing.keyPath) !== JSON.stringify(index.keyPath) || existing.multiEntry !== index.multiEntry || existing.unique !== index.unique;
          });
      }) || [...current.objectStoreNames].some((name) => !desiredStores.has(name));
      if (schemaDiffers) {
        const nextVersion = Math.max(current.version + 1, snapshot.version || 1);
        current.close();
        const upgrade = indexedDB.open(snapshot.name, nextVersion);
        upgrade.onupgradeneeded = () => {
          const database = upgrade.result;
          for (const storeName of [...database.objectStoreNames]) {
            if (!desiredStores.has(storeName)) database.deleteObjectStore(storeName);
          }
          for (const definition of snapshot.stores) {
            let store;
            if (database.objectStoreNames.contains(definition.name)) {
              store = upgrade.transaction.objectStore(definition.name);
              if (JSON.stringify(store.keyPath) !== JSON.stringify(definition.keyPath) || store.autoIncrement !== definition.autoIncrement) {
                database.deleteObjectStore(definition.name);
                store = database.createObjectStore(definition.name, { keyPath: definition.keyPath, autoIncrement: definition.autoIncrement });
              }
            } else {
              store = database.createObjectStore(definition.name, { keyPath: definition.keyPath, autoIncrement: definition.autoIncrement });
            }
            const desiredIndexes = new Set((definition.indexes || []).map((index) => index.name));
            for (const indexName of [...store.indexNames]) if (!desiredIndexes.has(indexName)) store.deleteIndex(indexName);
            for (const index of definition.indexes || []) {
              if (store.indexNames.contains(index.name)) {
                const existing = store.index(index.name);
                if (JSON.stringify(existing.keyPath) === JSON.stringify(index.keyPath) && existing.multiEntry === index.multiEntry && existing.unique === index.unique) continue;
                store.deleteIndex(index.name);
              }
              store.createIndex(index.name, index.keyPath, { multiEntry: index.multiEntry, unique: index.unique });
            }
          }
        };
        current = await request(upgrade);
      }
      for (const definition of snapshot.stores) {
        if (!current.objectStoreNames.contains(definition.name)) continue;
        const transaction = current.transaction(definition.name, "readwrite");
        const store = transaction.objectStore(definition.name);
        await request(store.clear());
        for (const record of definition.records || []) {
          const value = unpack(record.value);
          const key = unpack(record.key);
          await request(store.keyPath == null ? store.put(value, key) : store.put(value));
        }
      }
      current.close();
    }
  }
  if (Array.isArray(state.cacheStorage)) {
    const desired = new Set(state.cacheStorage.map((entry) => entry.name));
    for (const name of await caches.keys()) if (!desired.has(name)) await caches.delete(name);
    for (const snapshot of state.cacheStorage) {
      await caches.delete(snapshot.name);
      const cache = await caches.open(snapshot.name);
      for (const entry of snapshot.entries || []) {
        const requestValue = new Request(entry.request.url, { method: entry.request.method, headers: entry.request.headers });
        const responseValue = new Response(base64ToBytes(entry.response.body), { status: entry.response.status, statusText: entry.response.statusText, headers: entry.response.headers });
        await cache.put(requestValue, responseValue);
      }
    }
  }
  if (Array.isArray(state.serviceWorkers)) {
    const current = await navigator.serviceWorker.getRegistrations();
    const desired = new Set(state.serviceWorkers.map((worker) => worker.scope));
    for (const registration of current) if (!desired.has(registration.scope)) await registration.unregister();
    for (const worker of state.serviceWorkers) {
      if (!current.some((registration) => registration.scope === worker.scope)) {
        await navigator.serviceWorker.register(worker.scriptURL, { scope: worker.scope, updateViaCache: worker.updateViaCache });
      }
    }
  }
  return true;
}`;

const originForUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
};

const stateDigest = (value: BrowserOriginState): string =>
  createHash("sha256")
    .update(JSON.stringify({ ...value, capturedAt: undefined }))
    .digest("hex");

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly handlers = new Map<
    string,
    Set<(params: JsonObject, sessionId: string | undefined) => void>
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => void this.onMessage(event));
    socket.addEventListener("close", () => this.failPending(new Error("Browser CDP closed")));
    socket.addEventListener("error", () => this.failPending(new Error("Browser CDP failed")));
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Browser CDP connection timed out")),
        2_000
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Browser CDP connection failed"));
        },
        { once: true }
      );
    });
    return new CdpConnection(socket);
  }

  call<T>(method: string, params: JsonObject = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = method === "Runtime.evaluate" ? 30_000 : 2_000;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(
    method: string,
    handler: (params: JsonObject, sessionId: string | undefined) => void
  ): () => void {
    const handlers = this.handlers.get(method) ?? new Set();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(method);
    };
  }

  close(): void {
    this.socket.close();
    this.failPending(new Error("Browser CDP disconnected"));
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    const text =
      typeof event.data === "string"
        ? event.data
        : event.data instanceof Blob
          ? await event.data.text()
          : new TextDecoder().decode(event.data as ArrayBuffer);
    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: JsonObject;
      sessionId?: string;
      result?: unknown;
      error?: { message?: string };
    };
    if (typeof message.method === "string") {
      for (const handler of this.handlers.get(message.method) ?? []) {
        handler(message.params ?? {}, message.sessionId);
      }
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "Browser CDP error"));
    else pending.resolve(message.result);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

/**
 * Shares live browser origin state at the computer boundary without letting two
 * Chromium processes write the same profile. Each bot keeps its own UI/profile;
 * this broker reconciles cookies, local storage, IndexedDB, Cache Storage, and
 * service-worker registrations through each browser's local DevTools socket.
 */
export class BrowserBroker {
  private readonly peers = new Map<string, Peer>();
  private readonly attaching = new Map<string, Promise<void>>();
  private readonly cookies = new Map<string, BrowserCookie>();
  private readonly origins = new Map<string, BrowserOriginState>();
  private readonly stateDirectory: string;
  private readonly keyPath: string;
  private readonly storePath: string;
  private loaded = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncTail: Promise<void> = Promise.resolve();

  constructor(home = process.env.HOME ?? "/home/openbot") {
    this.stateDirectory = join(home, ".openbot");
    this.keyPath = join(this.stateDirectory, "browser-authority.key");
    this.storePath = join(this.stateDirectory, "browser-authority.json.enc");
  }

  attach(botId: string, port: number, profileDirectory = "", attempts = 1): Promise<void> {
    if (this.peers.has(botId)) return Promise.resolve();
    const current = this.attaching.get(botId);
    if (current) {
      // A screen-status probe may already be doing a single non-blocking
      // discovery attempt while Chromium is launching. A launch-triggered
      // caller with retries must get a fresh attempt after that probe settles.
      return attempts > 1
        ? current.then(() => this.attach(botId, port, profileDirectory, attempts))
        : current;
    }
    const pending = this.attachInner(botId, port, profileDirectory, attempts).finally(() => {
      this.attaching.delete(botId);
    });
    this.attaching.set(botId, pending);
    return pending;
  }

  async detach(botId: string): Promise<void> {
    await this.attaching.get(botId)?.catch(() => undefined);
    await this.enqueueSync();
    const peer = this.peers.get(botId);
    if (!peer) return;
    this.peers.delete(botId);
    peer.cdp.close();
    if (this.peers.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async attachInner(
    botId: string,
    port: number,
    profileDirectory: string,
    attempts: number
  ): Promise<void> {
    await this.load();
    let version: { webSocketDebuggerUrl?: string } | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(250),
        });
        if (response.ok) version = (await response.json()) as { webSocketDebuggerUrl?: string };
      } catch {
        // Chromium may still be starting.
      }
      if (version?.webSocketDebuggerUrl) break;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!version?.webSocketDebuggerUrl) return;
    const cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);
    const local = await this.readCookies(cdp);
    for (const [key, cookie] of local) {
      if (!this.cookies.has(key)) this.cookies.set(key, cookie);
    }
    const peer: Peer = {
      botId,
      port,
      profileDirectory,
      cdp,
      baseline: local,
      targets: new Map(),
      originBaselines: new Map(),
    };
    this.peers.set(botId, peer);
    await this.setCookies(peer, [...this.cookies.values()]);
    peer.baseline = await this.readCookies(peer.cdp);
    await peer.cdp.call("Target.setDiscoverTargets", { discover: true });
    await this.refreshTargets(peer, true);
    await this.save();
    if (!this.timer) {
      this.timer = setInterval(() => void this.enqueueSync(), 1_500);
      this.timer.unref?.();
    }
  }

  private enqueueSync(): Promise<void> {
    this.syncTail = this.syncTail.then(
      () => this.reconcile(),
      () => this.reconcile()
    );
    return this.syncTail;
  }

  private async reconcile(): Promise<void> {
    const updates = new Map<string, BrowserCookie>();
    const deletions = new Map<string, BrowserCookie>();
    for (const peer of [...this.peers.values()]) {
      try {
        const current = await this.readCookies(peer.cdp);
        for (const [key, previous] of peer.baseline) {
          if (!current.has(key)) deletions.set(key, previous);
        }
        for (const [key, cookie] of current) {
          if (JSON.stringify(peer.baseline.get(key)) !== JSON.stringify(cookie)) {
            updates.set(key, cookie);
          }
        }
        peer.baseline = current;
      } catch {
        this.peers.delete(peer.botId);
        peer.cdp.close();
      }
    }
    for (const key of updates.keys()) deletions.delete(key);
    const changedOrigins = new Map<string, BrowserOriginState>();
    for (const peer of [...this.peers.values()]) {
      try {
        await this.refreshTargets(peer, false);
        for (const target of peer.targets.values()) {
          const snapshot = await this.readOriginState(peer, target);
          if (!snapshot) continue;
          const digest = stateDigest(snapshot);
          const baseline = peer.originBaselines.get(target.origin);
          if (baseline !== undefined && baseline !== digest) {
            const merged = { ...this.origins.get(target.origin), ...snapshot };
            this.origins.set(target.origin, merged);
            changedOrigins.set(target.origin, merged);
          } else if (!this.origins.has(target.origin)) {
            this.origins.set(target.origin, snapshot);
            changedOrigins.set(target.origin, snapshot);
          }
          peer.originBaselines.set(target.origin, digest);
        }
      } catch {
        this.peers.delete(peer.botId);
        peer.cdp.close();
      }
    }
    if (updates.size === 0 && deletions.size === 0 && changedOrigins.size === 0) return;
    for (const [key, cookie] of updates) this.cookies.set(key, cookie);
    for (const key of deletions.keys()) this.cookies.delete(key);
    for (const peer of [...this.peers.values()]) {
      try {
        for (const cookie of deletions.values()) await this.deleteCookie(peer, cookie);
        await this.setCookies(peer, [...updates.values()]);
        peer.baseline = await this.readCookies(peer.cdp);
        for (const [origin, snapshot] of changedOrigins) {
          for (const target of peer.targets.values()) {
            if (target.origin !== origin) continue;
            await this.writeOriginState(peer, target, snapshot);
            const restored = await this.readOriginState(peer, target);
            if (restored) peer.originBaselines.set(origin, stateDigest(restored));
          }
        }
      } catch {
        this.peers.delete(peer.botId);
        peer.cdp.close();
      }
    }
    await this.save();
  }

  private async refreshTargets(peer: Peer, restoreAuthority: boolean): Promise<void> {
    const result = await peer.cdp.call<{
      targetInfos?: Array<{ targetId?: string; type?: string; url?: string }>;
    }>("Target.getTargets");
    const active = new Set<string>();
    for (const info of result.targetInfos ?? []) {
      if (info.type !== "page" || typeof info.targetId !== "string" || typeof info.url !== "string")
        continue;
      const origin = originForUrl(info.url);
      if (!origin) continue;
      active.add(info.targetId);
      let target = peer.targets.get(info.targetId);
      if (!target) {
        const attached = await peer.cdp.call<{ sessionId?: string }>("Target.attachToTarget", {
          targetId: info.targetId,
          flatten: true,
        });
        if (!attached.sessionId) continue;
        target = { targetId: info.targetId, sessionId: attached.sessionId, origin };
        peer.targets.set(info.targetId, target);
      } else if (target.origin !== origin) {
        target.origin = origin;
      }
      const authority = this.origins.get(origin);
      if (authority && (restoreAuthority || !peer.originBaselines.has(origin))) {
        await this.writeOriginState(peer, target, authority);
      }
      if (!peer.originBaselines.has(origin)) {
        const snapshot = await this.readOriginState(peer, target);
        if (snapshot) peer.originBaselines.set(origin, stateDigest(snapshot));
      }
    }
    for (const [targetId] of peer.targets) {
      if (!active.has(targetId)) peer.targets.delete(targetId);
    }
  }

  private async readOriginState(
    peer: Peer,
    target: BrowserTarget
  ): Promise<BrowserOriginState | null> {
    try {
      const evaluated = await peer.cdp.call<{
        result?: { value?: unknown };
        exceptionDetails?: unknown;
      }>(
        "Runtime.evaluate",
        {
          expression: BROWSER_STATE_EXPORT_EXPRESSION,
          awaitPromise: true,
          returnByValue: true,
          userGesture: false,
        },
        target.sessionId
      );
      if (evaluated.exceptionDetails) return null;
      const value = evaluated.result?.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const state = value as BrowserOriginState;
      if (state.origin !== target.origin) return null;
      // Avoid turning an unexpectedly huge site database into an unbounded
      // encrypted authority file. The browser keeps its local copy intact.
      if (JSON.stringify(state).length > 64 * 1024 * 1024) return null;
      return state;
    } catch {
      return null;
    }
  }

  private async writeOriginState(
    peer: Peer,
    target: BrowserTarget,
    state: BrowserOriginState
  ): Promise<void> {
    if (state.origin !== target.origin) return;
    const expression = `(${BROWSER_STATE_IMPORT_FUNCTION})(${JSON.stringify(state)})`;
    try {
      await peer.cdp.call(
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: false,
        },
        target.sessionId
      );
    } catch {
      // A page can navigate or close while its origin state is being restored.
    }
  }

  private async readCookies(cdp: CdpConnection): Promise<Map<string, BrowserCookie>> {
    const result = await cdp.call<{ cookies?: unknown[] }>("Storage.getCookies");
    return cookieMap(result.cookies ?? []);
  }

  private async setCookies(peer: Peer, cookies: BrowserCookie[]): Promise<void> {
    for (const cookie of cookies) {
      if (cookie.partitionKeyOpaque) continue;
      try {
        await peer.cdp.call("Storage.setCookies", { cookies: [cookieParameter(cookie)] });
      } catch {
        // A browser may reject a cookie whose source/partition attributes it cannot reproduce.
      }
    }
  }

  private async deleteCookie(peer: Peer, cookie: BrowserCookie): Promise<void> {
    const expired: JsonObject = {
      name: cookie.name,
      value: "",
      domain: cookie.domain,
      path: cookie.path,
      expires: 1,
    };
    if (cookie.partitionKey && !cookie.partitionKeyOpaque)
      expired.partitionKey = cookie.partitionKey;
    // Not every Chromium exposes browser-level Storage.deleteCookies. Replacing
    // the exact cookie with an already-expired value is compatible and keeps the
    // domain, path, and partition identity intact.
    await peer.cdp.call("Storage.setCookies", { cookies: [expired] });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    try {
      const key = await this.key();
      const packed = JSON.parse(await readFile(this.storePath, "utf8")) as {
        iv: string;
        tag: string;
        data: string;
      };
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(packed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(packed.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(packed.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const unpacked = JSON.parse(plaintext) as
        | unknown[]
        | { version?: unknown; cookies?: unknown; origins?: unknown };
      const cookieValues = Array.isArray(unpacked)
        ? unpacked
        : Array.isArray(unpacked.cookies)
          ? unpacked.cookies
          : [];
      for (const value of cookieValues) {
        const cookie = asCookie(value);
        if (cookie) this.cookies.set(cookieKey(cookie), cookie);
      }
      if (!Array.isArray(unpacked) && unpacked.origins && typeof unpacked.origins === "object") {
        for (const [origin, value] of Object.entries(unpacked.origins)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const state = value as BrowserOriginState;
          if (state.origin === origin && originForUrl(origin) === origin)
            this.origins.set(origin, state);
        }
      }
    } catch {
      // The first launch has no authority store. A corrupt store is safely ignored.
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const persistent = [...this.cookies.values()].filter(
      (cookie) => typeof cookie.expires === "number" && cookie.expires > 0
    );
    const key = await this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(
        JSON.stringify({
          version: 2,
          cookies: persistent,
          origins: Object.fromEntries(this.origins),
        }),
        "utf8"
      ),
      cipher.final(),
    ]);
    const temporary = `${this.storePath}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          data: encrypted.toString("base64"),
        }),
        { mode: 0o600 }
      );
      await rename(temporary, this.storePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async key(): Promise<Buffer> {
    try {
      const existing = await readFile(this.keyPath);
      if (existing.length === 32) return existing;
    } catch {
      // Generated below.
    }
    const key = randomBytes(32);
    await writeFile(this.keyPath, key, { mode: 0o600 });
    return key;
  }
}

export const browserCookieInternals = { asCookie, cookieKey, cookieParameter };
export const browserStateInternals = {
  exportExpression: BROWSER_STATE_EXPORT_EXPRESSION,
  importFunction: BROWSER_STATE_IMPORT_FUNCTION,
  originForUrl,
  stateDigest,
};
