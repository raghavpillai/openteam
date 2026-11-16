import { afterEach, expect, test } from "bun:test";
import { locationForSend, setLocationSharing } from "../src/renderer/lib/location";
const original = {
  window: globalThis.window,
  localStorage: globalThis.localStorage,
  navigator: globalThis.navigator,
};
afterEach(() => {
  for (const [key, value] of Object.entries(original))
    Object.defineProperty(globalThis, key, { configurable: true, value });
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
