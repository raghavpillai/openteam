import { afterEach, expect, test } from "bun:test";
import { locationForSend, readPosition, setLocationSharing } from "../src/renderer/lib/location";
import type { NativeLocationResult } from "../src/renderer/lib/location-types";
const original = {
  window: globalThis.window,
  localStorage: globalThis.localStorage,
  navigator: globalThis.navigator,
};
afterEach(() => {
  setLocationSharing(false);
  for (const [key, value] of Object.entries(original))
    Object.defineProperty(globalThis, key, { configurable: true, value });
});

const nativeLocation = {
  latitude: 40, longitude: -73, accuracyMeters: 15,
  capturedAt: new Date().toISOString(), device: "computer" as const,
};

const installNativeLocation = (read: () => Promise<NativeLocationResult>) => {
  const storage = new Map<string, string>();
  const window = Object.assign(new EventTarget(), { openteam: { location: { readPosition: read } } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { geolocation: { getCurrentPosition: () => { throw new Error("Chromium must not be used on macOS"); } } },
  });
  setLocationSharing(false);
};

test("macOS reads through the native bridge and caches the fix for sends", async () => {
  let calls = 0;
  installNativeLocation(async () => { calls++; return { location: nativeLocation }; });
  expect(await readPosition()).toEqual(nativeLocation);
  setLocationSharing(true);
  expect(await locationForSend()).toEqual(nativeLocation);
  expect(calls).toBe(1);
});

test("native denial keeps its permission code across IPC and a retry can succeed", async () => {
  let calls = 0;
  installNativeLocation(async () => ++calls === 1
    ? { error: { code: 1, message: "Location access denied" } }
    : { location: nativeLocation });
  await expect(readPosition()).rejects.toMatchObject({ code: 1 });
  expect(await readPosition()).toEqual(nativeLocation);
  expect(calls).toBe(2);
});

test("native unavailable and timeout errors retain their distinct codes", async () => {
  for (const code of [2, 3] as const) {
    installNativeLocation(async () => ({ error: { code, message: "No location fix" } }));
    await expect(readPosition()).rejects.toMatchObject({ code });
  }
});

test("concurrent native requests share one fix and disabling sharing fences it", async () => {
  let complete!: (value: NativeLocationResult) => void;
  let calls = 0;
  installNativeLocation(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  setLocationSharing(true);
  const sending = locationForSend();
  const reading = readPosition();
  expect(calls).toBe(1);
  setLocationSharing(false);
  complete({ location: nativeLocation });
  expect(await reading).toEqual(nativeLocation);
  expect(await sending).toBeUndefined();
  // Re-enabling must ask again rather than reusing the discarded native fix.
  setLocationSharing(true);
  const fresh = locationForSend();
  expect(calls).toBe(2);
  complete({ location: nativeLocation });
  expect(await fresh).toEqual(nativeLocation);
});
test("turning location off fences an in-flight fix and its cached result", async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  let complete!: PositionCallback;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      geolocation: {
        getCurrentPosition: (success: PositionCallback) => {
          complete = success;
        },
      },
    },
  });
  setLocationSharing(true);
  const sending = locationForSend();
  setLocationSharing(false);
  complete({
    coords: { latitude: 40, longitude: -73, accuracy: 15 },
    timestamp: Date.now(),
  } as GeolocationPosition);
  expect(await sending).toBeUndefined();
  setLocationSharing(true);
  let received = false;
  const fresh = locationForSend().then(() => {
    received = true;
  });
  await Promise.resolve();
  expect(received).toBe(false);
  complete({
    coords: { latitude: 41, longitude: -74, accuracy: 10 },
    timestamp: Date.now(),
  } as GeolocationPosition);
  await fresh;
  setLocationSharing(false);
});
