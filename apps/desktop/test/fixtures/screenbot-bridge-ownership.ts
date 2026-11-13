import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const fakeWindow = new EventTarget() as EventTarget & { openteam: unknown };
Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
let scope: string | null = "A";
const authListeners = new Set<() => void>();
mock.module("../../src/renderer/client/auth", () => ({
  authHeaders: () => ({}),
  AUTH_CREDENTIALS_CHANGED_EVENT: "owned-auth-change",
  getScreenBotAccountScope: () => scope,
  subscribeAuthSnapshot: (listener: () => void) => {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  },
}));
mock.module("../../src/renderer/client/http", () => ({ API_BASE: "https://owned.invalid" }));
mock.module("../../src/renderer/lib/theme", () => ({
  readThemePreference: () => "light",
  THEME_CHANGE_EVENT: "owned-theme-change",
}));
let bootstrap: () => Promise<any>;
let transcribe: () => Promise<{ text: string }>;
mock.module("../../src/renderer/client/openteam-api", () => ({
  api: { bootstrap: () => bootstrap(), transcribeAudio: () => transcribe() },
}));
const enqueued: Array<{ scope: string | null; request: any }> = [];
let enqueue: () => Promise<void>;
mock.module("../../src/renderer/lib/durable-sends", () => ({
  desktopDurableSendController: () => {
    const owner = scope;
    return {
      enqueue: async (request: any) => {
        enqueued.push({ scope: owner, request });
        await enqueue();
      },
    };
  },
  discardDesktopDeliveryStages: async () => {},
}));
const { startScreenBotBridge } = await import("../../src/renderer/lib/screenbot-bridge");
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const snapshot = (id = "shared-bot") => ({
  bots: [
    {
      id,
      name: id,
      dmChannelId: "channel-" + id,
      conversationId: null,
      status: "ready",
      hasAvatar: false,
    },
  ],
  latestMessages: [],
  runtime: { transcription: "configured" },
});
const published: any[] = [];
let deliver!: (request: any) => Promise<void>;
let transcribeRequest!: (request: any) => Promise<string>;
let rosterRequest!: () => void;
let stop: () => void;
const changeScope = (next: string | null) => {
  scope = null;
  fakeWindow.dispatchEvent(new Event("owned-auth-change"));
  scope = next;
  for (const listener of authListeners) listener();
};
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const request = (accountScope = "A", botId = "shared-bot") => ({
  accountScope,
  botId,
  content: "Owned words",
  nonce: "owned-shot",
  staged: {
    stagingId: "owned-stage",
    fileName: "Owned.png",
    mimeType: "image/png",
    byteSize: 1,
    width: 8,
    height: 8,
  },
});
beforeEach(() => {
  scope = "A";
  published.length = 0;
  enqueued.length = 0;
  bootstrap = async () => snapshot();
  transcribe = async () => ({ text: "Owned words" });
  enqueue = async () => {};
  fakeWindow.openteam = {
    screenbot: {
      publishRoster: (value: unknown) => published.push(value),
      onDeliver: (handler: typeof deliver) => {
        deliver = handler;
        return () => {};
      },
      onTranscribe: (handler: typeof transcribeRequest) => {
        transcribeRequest = handler;
        return () => {};
      },
      onRosterRequest: (handler: () => void) => {
        rosterRequest = handler;
        return () => {};
      },
    },
  };
});
afterEach(() => stop?.());
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("normal delivery is pinned to its account and same-account empty refresh retains scope", async () => {
  stop = startScreenBotBridge();
  await settle();
  await deliver(request());
  expect(enqueued[0]!.scope).toBe("A");
  expect(enqueued[0]!.request.target.channelId).toBe("channel-shared-bot");
  expect(published.at(-1).accountScope).toBe("A");
  bootstrap = async () => ({ ...snapshot(), bots: [] });
  // A miss causes the normal refresh path without needing timers or a live bot list.
  await expect(deliver(request("A", "missing"))).rejects.toThrow("no longer available");
  expect(published.at(-1)).toMatchObject({ accountScope: "A", bots: [] });
});

test("late bootstrap from A cannot publish into replacement B even with identical bot ids", async () => {
  const pending = deferred<any>();
  bootstrap = () => pending.promise;
  stop = startScreenBotBridge();
  bootstrap = async () => snapshot();
  changeScope("B");
  await settle();
  const count = published.length;
  pending.resolve(snapshot("private-A"));
  await settle();
  expect(published).toHaveLength(count);
  expect(published.at(-1).accountScope).toBe("B");
  await expect(deliver(request())).rejects.toThrow("account changed");
  await deliver(request("B"));
  expect(enqueued.at(-1)!.scope).toBe("B");
});

test("account replacement while delivery refresh waits never enqueues A into B", async () => {
  stop = startScreenBotBridge();
  await settle();
  const pending = deferred<any>();
  bootstrap = () => pending.promise;
  const delivery = deliver(request("A", "missing"));
  bootstrap = async () => snapshot("missing");
  changeScope("B");
  await settle();
  pending.resolve(snapshot("missing"));
  await expect(delivery).rejects.toThrow("account changed");
  expect(enqueued).toHaveLength(0);
});

test("pending enqueue completion is rejected after sign-out/relogin to same account", async () => {
  stop = startScreenBotBridge();
  await settle();
  const pending = deferred<void>();
  enqueue = () => pending.promise;
  const delivery = deliver(request());
  changeScope("A-new-login");
  await settle();
  pending.resolve();
  await expect(delivery).rejects.toThrow("account changed");
  expect(enqueued[0]!.scope).toBe("A");
  expect(enqueued).toHaveLength(1);
});

test("late synthetic transcription cannot restore words in the replacement account", async () => {
  stop = startScreenBotBridge();
  await settle();
  const pending = deferred<{ text: string }>();
  transcribe = () => pending.promise;
  const result = transcribeRequest({
    accountScope: "A",
    audio: new Uint8Array([1]),
    mimeType: "audio/webm",
  });
  changeScope("B");
  pending.resolve({ text: "Private A" });
  await expect(result).rejects.toThrow("account changed");
});

test("workspace cleanup fences pending refresh and removes auth/theme listeners", async () => {
  const pending = deferred<any>();
  bootstrap = () => pending.promise;
  stop = startScreenBotBridge();
  stop();
  const count = published.length;
  pending.resolve(snapshot());
  await settle();
  rosterRequest();
  fakeWindow.dispatchEvent(new Event("owned-theme-change"));
  changeScope("B");
  expect(published).toHaveLength(count);
  expect(published.at(-1)).toEqual({ accountScope: null, bots: [], dictation: false });
  expect(authListeners.size).toBe(0);
  await expect(deliver(request())).rejects.toThrow("account changed");
});
