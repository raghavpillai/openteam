import { createHash } from "node:crypto";
import type { JsonObject } from "./cdp-connection";

export interface BrowserOriginState extends JsonObject {
  origin: string;
  capturedAt: string;
  localStorage?: Array<[string, string]>;
  indexedDb?: unknown[];
  cacheStorage?: unknown[];
  serviceWorkers?: unknown[];
}

export const BROWSER_STATE_EXPORT_EXPRESSION = String.raw`(async () => {
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

export const BROWSER_STATE_IMPORT_FUNCTION = String.raw`async (state) => {
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

export const originForUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
};

export const stateDigest = (value: BrowserOriginState): string =>
  createHash("sha256")
    .update(JSON.stringify({ ...value, capturedAt: undefined }))
    .digest("hex");
