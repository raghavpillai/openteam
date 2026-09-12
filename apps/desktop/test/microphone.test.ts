import { afterEach, expect, test } from "bun:test";
import { microphoneErrorMessage, openMicrophone } from "../src/renderer/lib/microphone";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  for (const [key, descriptor] of [
    ["navigator", originalNavigator],
    ["window", originalWindow],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function setup(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia } },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
}
const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

test.each([
  "NotFoundError",
  "OverconstrainedError",
  "NotReadableError",
])("a saved microphone falling offline (%s) retries the default once", async (name) => {
  const calls: MediaStreamConstraints[] = [];
  const stream = {} as MediaStream;
  setup(async (request) => {
    calls.push(request);
    if (calls.length === 1) throw new DOMException("Unavailable", name);
    return stream;
  });
  expect(await openMicrophone({ deviceId: "usb-mic" })).toEqual({ stream, usedFallback: true });
  expect(calls).toEqual([
    { audio: { ...constraints, deviceId: { exact: "usb-mic" } } },
    { audio: constraints },
  ]);
});

test("permission denial never falls back to another microphone", async () => {
  let calls = 0;
  setup(async () => {
    calls++;
    throw new DOMException("Denied", "NotAllowedError");
  });
  await expect(openMicrophone({ deviceId: "usb-mic" })).rejects.toMatchObject({
    name: "NotAllowedError",
  });
  expect(calls).toBe(1);
});

test("cancelling permission prevents a fallback request", async () => {
  const abort = new AbortController();
  let calls = 0;
  setup(async () => {
    calls++;
    abort.abort();
    throw new DOMException("Unavailable", "NotFoundError");
  });
  await expect(openMicrophone({ deviceId: "usb-mic", signal: abort.signal })).rejects.toMatchObject(
    { name: "AbortError" }
  );
  expect(calls).toBe(1);
});

test("a late permission grant releases the microphone after cancellation", async () => {
  const abort = new AbortController();
  let stopped = 0;
  setup(async () => {
    abort.abort();
    return { getTracks: () => [{ stop: () => stopped++ }] } as unknown as MediaStream;
  });
  await expect(openMicrophone({ deviceId: "", signal: abort.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(stopped).toBe(1);
});

test("a failed default microphone is not retried indefinitely", async () => {
  let calls = 0;
  setup(async () => {
    calls++;
    throw new DOMException("No input", "NotFoundError");
  });
  await expect(openMicrophone({ deviceId: "" })).rejects.toMatchObject({ name: "NotFoundError" });
  expect(calls).toBe(1);
});

test.each([
  ["NotFoundError", "No microphone found"],
  ["NotAllowedError", "Allow microphone access"],
  ["NotReadableError", "unavailable or in use"],
  ["OverconstrainedError", "Choose another microphone"],
])("microphone failures explain how to recover from %s", (name, detail) => {
  expect(microphoneErrorMessage(new DOMException("Internal detail", name))).toContain(detail);
});
