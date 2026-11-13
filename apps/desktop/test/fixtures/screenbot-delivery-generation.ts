import { afterAll, beforeEach, expect, mock, test } from "bun:test";

// Exercise the desktop adapter's real stage-read/upload boundary with inert durable runtime.
const originals = ["window", "document", "navigator"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
);
let generation = 1;
const windowFixture = Object.assign(new EventTarget(), {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  openteam: {
    files: {
      readDeliveryStage: (_id: string): Promise<Uint8Array> => readStage(),
      discardDeliveryStages: async () => {},
    },
  },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: windowFixture });
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: Object.assign(new EventTarget(), { visibilityState: "visible" }),
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
mock.module("../../src/renderer/client/auth", () => ({
  AUTH_CREDENTIALS_CHANGED_EVENT: "owned-credentials",
  getAuthCredentialGeneration: () => generation,
  getAuthSnapshot: () => ({ mode: "required", user: { id: "same-owner" } }),
  subscribeAuthSnapshot: () => () => {},
}));
mock.module("../../src/renderer/client/http", () => ({ API_BASE: "https://owned.invalid" }));
mock.module("../../src/renderer/lib/performance", () => ({ recordPerformance() {} }));
let readStage: () => Promise<Uint8Array>;
let upload: () => Promise<any>;
let uploadCalls = 0,
  disposeCalls = 0;
mock.module("../../src/renderer/client/openteam-api", () => ({
  api: {
    uploadAsset: async () => {
      uploadCalls++;
      return upload();
    },
  },
}));
let runtime: any;
mock.module("@openteam/product-core/durable-delivery", () => ({
  classifyDurableSendError: () => "offline",
  messageDeliveryAcceptance: () => ({}),
  createDurableSendController: (_scope: string, _storage: unknown, options: unknown) => {
    runtime = options;
    return {
      restore: async () => {},
      flush: async () => {},
      getSnapshot: () => [],
      subscribe: () => () => {},
      dispose: () => {
        disposeCalls++;
      },
    };
  },
}));
const { desktopDurableSendController } = await import("../../src/renderer/lib/durable-sends");
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const record = {
  payload: {
    stagedAttachments: [
      { stagingId: "owned-stage", fileName: "Owned.png", mimeType: "image/png", position: 0 },
    ],
  },
};
const replaceCredentials = () => {
  generation++;
  windowFixture.dispatchEvent(new Event("owned-credentials"));
};
beforeEach(() => {
  replaceCredentials();
  uploadCalls = 0;
  disposeCalls = 0;
  readStage = async () => new Uint8Array([1]);
  upload = async () => ({ assetId: "owned-asset" });
  desktopDurableSendController();
});
afterAll(() => {
  replaceCredentials();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("current-generation staged image uploads normally", async () => {
  expect(await runtime.commitStagedAttachments(record)).toEqual([{ assetId: "owned-asset" }]);
  expect(uploadCalls).toBe(1);
});

test("relogin while stage read awaits prevents upload under replacement credentials", async () => {
  const pending = deferred<Uint8Array>();
  readStage = () => pending.promise;
  const oldRuntime = runtime;
  const result = oldRuntime.commitStagedAttachments(record);
  replaceCredentials();
  desktopDurableSendController();
  expect(runtime).not.toBe(oldRuntime);
  expect(disposeCalls).toBe(1);
  pending.resolve(new Uint8Array([1]));
  await expect(result).rejects.toThrow("Delivery account changed");
  expect(uploadCalls).toBe(0);
});

test("late upload result is fenced after credential replacement", async () => {
  const pending = deferred<any>(),
    entered = deferred<void>();
  upload = () => {
    entered.resolve();
    return pending.promise;
  };
  const result = runtime.commitStagedAttachments(record);
  await entered.promise;
  replaceCredentials();
  pending.resolve({ assetId: "old-account-asset" });
  await expect(result).rejects.toThrow("Delivery account changed");
  expect(uploadCalls).toBe(1);
});
