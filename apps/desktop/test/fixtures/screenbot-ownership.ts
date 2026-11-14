import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// No desktop, OS permissions, global shortcuts, audio, or network: only owned 8×8 pixels.
const ipc = Object.assign(new EventEmitter(), {
  handles: new Map<string, (...args: any[]) => any>(),
  handle(name: string, handler: (...args: any[]) => any) {
    this.handles.set(name, handler);
  },
  removeHandler(name: string) {
    this.handles.delete(name);
  },
});
const traffic: Array<{ window: FakeWindow; channel: string; payload: any }> = [];
const windows: FakeWindow[] = [];
let replyAutomatically = true;
class FakeWindow extends EventEmitter {
  visible = false;
  destroyed = false;
  bounds = display.bounds;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    setWindowOpenHandler() {},
    setBackgroundThrottling() {},
    setZoomLevel() {},
    send: (channel: string, payload: any) => {
      traffic.push({ window: this, channel, payload });
      if (channel === "openteam:screenbot:deliver" && replyAutomatically) {
        queueMicrotask(() =>
          ipc.emit("openteam:screenbot:delivered", event(this), {
            requestId: payload.requestId,
            ok: true,
          })
        );
      }
    },
  });
  constructor(_options?: unknown) {
    super();
    windows.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
  isVisible() {
    return this.visible;
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents() {}
  setOpacity() {}
  setBounds(bounds: typeof display.bounds) {
    this.bounds = bounds;
  }
  getBounds() {
    return this.bounds;
  }
  showInactive() {
    this.visible = true;
  }
  focus() {}
  hide() {
    this.visible = false;
  }
}
const display = {
  id: 987,
  scaleFactor: 1,
  size: { width: 8, height: 8 },
  bounds: { x: 0, y: 0, width: 8, height: 8 },
  workArea: { x: 0, y: 0, width: 8, height: 8 },
};
const image = {
  getSize: () => ({ width: 8, height: 8 }),
  toBitmap: () => Buffer.alloc(8 * 8 * 4, 123),
  toJPEG: () => Buffer.from([1, 2, 3]),
  isEmpty: () => false,
};
let captureImage = async () => [{ display_id: "987", thumbnail: image }];
mock.module("electron", () => ({
  BrowserWindow: FakeWindow,
  ipcMain: ipc,
  desktopCapturer: { getSources: () => captureImage() },
  dialog: {
    showMessageBox: () => {
      throw new Error("OS dialogs forbidden");
    },
  },
  screen: { getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  shell: {
    openExternal: () => {
      throw new Error("OS settings forbidden");
    },
  },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
}));
const { DesktopScreenBot } = await import("../../src/main/screenbot");
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const event = (window: FakeWindow) => ({
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame,
});
const bot = {
  id: "shared-bot-id",
  name: "Synthetic Bot",
  color: "blue",
  icon: "chip",
  channelId: "shared-channel",
};
let subject: any, main: FakeWindow;
let stage: (id: string, bytes: Uint8Array) => Promise<void>;
let load: () => Promise<void>;
const staged: string[] = [],
  discarded: string[] = [];
const roster = (accountScope: string | null, bots = accountScope ? [bot] : []) =>
  ipc.emit("openteam:screenbot:roster", event(main), { accountScope, bots, dictation: true });
const overlay = () => windows[windows.length - 1]!;
const take = async () => {
  subject.lastPressAt = -Infinity;
  subject.shownAt = -Infinity;
  await subject.take();
  const shot = traffic.filter((item) => item.channel === "screenbot:shot").at(-1)!.payload;
  ipc.emit("screenbot:ready", event(overlay()), shot.id);
  return shot;
};
const draft = (value: string, shot: any, accountScope = "A") =>
  ipc.emit("screenbot:draft", event(overlay()), { draft: value, shotId: shot.id, accountScope });
const send = (shot: any) =>
  ipc.handles.get("screenbot:send")!(event(overlay()), {
    shotId: shot.id,
    botId: bot.id,
    content: "Owned draft",
  });
const deliveries = () => traffic.filter((item) => item.channel === "openteam:screenbot:deliver");

beforeEach(() => {
  ipc.removeAllListeners();
  ipc.handles.clear();
  windows.length = 0;
  traffic.length = 0;
  staged.length = 0;
  discarded.length = 0;
  replyAutomatically = true;
  captureImage = async () => [{ display_id: "987", thumbnail: image }];
  stage = async () => {};
  load = async () => {};
  main = new FakeWindow();
  subject = new DesktopScreenBot({
    preloadPath: "owned-fixture",
    loadPage: () => load(),
    mainWindow: () => main as any,
    focusMainWindow() {},
    stageDelivery: async (id, bytes) => {
      staged.push(id);
      await stage(id, bytes);
    },
    discardDelivery: async (id) => {
      discarded.push(id);
    },
  });
  roster("A");
});
afterEach(() => subject.dispose());

test("same-account roster refresh, including empty, preserves shot and draft", async () => {
  const shot = await take();
  draft("Private A", shot);
  const capture = subject.capture;
  roster("A", []);
  roster("A");
  expect(subject.capture).toBe(capture);
  expect(subject.draft).toBe("Private A");
  expect((await send(shot)).ok).toBe(true);
  expect(deliveries()).toHaveLength(1);
  expect(deliveries()[0]!.payload.accountScope).toBe("A");
  expect(subject.capture).toBeNull();
});

test("ordinary main-window hide still accepts the last shot's scoped draft flush", async () => {
  const shot = await take();
  subject.hideOverlay();
  draft("Last words before close", shot);
  expect(subject.capture).toBeNull();
  expect(subject.draft).toBe("Last words before close");
  const next = await take();
  draft("Late old words", shot);
  expect(subject.draft).toBe("Last words before close");
  expect(next.draft).toBe("Last words before close");
});

test.each([
  null,
  "B",
])("scope replacement %s discards capture and draft even with identical bot ids", async (scope) => {
  const shot = await take();
  draft("Private A", shot);
  const capture = subject.capture;
  roster(scope);
  expect(subject.capture).toBeNull();
  expect(subject.draft).toBe("");
  expect(capture.encoding.signal.aborted).toBe(true);
  expect(overlay().visible).toBe(false);
  expect((await send(shot)).ok).toBe(false);
  expect(deliveries()).toHaveLength(0);
});

test("sign-out/relogin to the same account rejects old sends and delayed draft IPC", async () => {
  const old = await take();
  roster(null);
  roster("A-new-login");
  const fresh = await take();
  draft("B/current", fresh, "A-new-login");
  draft("Private old", old);
  expect(subject.draft).toBe("B/current");
  expect((await send(old)).ok).toBe(false);
  expect((await send(fresh)).ok).toBe(true);
});

test("replacement during native capture cannot create an old-account shot", async () => {
  const gate = deferred<Awaited<ReturnType<typeof captureImage>>>();
  captureImage = () => gate.promise;
  const taking = subject.take();
  await Promise.resolve();
  await Promise.resolve();
  roster("B");
  gate.resolve([{ display_id: "987", thumbnail: image }]);
  await taking;
  expect(subject.capture).toBeNull();
  expect(traffic.filter((item) => item.channel === "screenbot:shot")).toHaveLength(0);
});

test("replacement while overlay loads cannot reveal the pending shot", async () => {
  const gate = deferred<void>();
  load = () => gate.promise;
  const taking = subject.take();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  roster("B");
  gate.resolve();
  await taking;
  expect(subject.capture).toBeNull();
  expect(traffic.filter((item) => item.channel === "screenbot:shot")).toHaveLength(0);
});

test("replacement during encode cannot stage or dispatch old pixels", async () => {
  const shot = await take(),
    gate = deferred<any>();
  subject.capture.png = gate.promise;
  const sending = send(shot);
  roster("B");
  gate.resolve({
    bytes: new Uint8Array([1]),
    mimeType: "image/png",
    fileName: "Owned.png",
    width: 8,
    height: 8,
  });
  expect((await sending).ok).toBe(false);
  expect(staged).toHaveLength(0);
  expect(deliveries()).toHaveLength(0);
});

test("replacement during staging discards completed stage and cannot dispatch", async () => {
  const shot = await take(),
    entered = deferred<void>(),
    gate = deferred<void>();
  stage = async () => {
    entered.resolve();
    await gate.promise;
  };
  const sending = send(shot);
  await entered.promise;
  roster("B");
  gate.resolve();
  expect((await sending).ok).toBe(false);
  expect(discarded).toEqual(staged);
  expect(deliveries()).toHaveLength(0);
});

test("late delivery completion cannot clear a replacement account's draft", async () => {
  replyAutomatically = false;
  const shot = await take();
  const sending = send(shot);
  // Wait for synthetic encoding, never a real screen or external send.
  for (let i = 0; !deliveries().length && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(deliveries()).toHaveLength(1);
  const request = deliveries()[0]!.payload;
  roster("B");
  const fresh = await take();
  draft("Current B", fresh, "B");
  ipc.emit("openteam:screenbot:delivered", event(main), { requestId: request.requestId, ok: true });
  expect((await sending).ok).toBe(false);
  expect(subject.draft).toBe("Current B");
  expect(subject.capture.id).toBe(fresh.id);
});

test("same-account rejected delivery retains the shot for retry", async () => {
  replyAutomatically = false;
  const shot = await take();
  draft("Retry words", shot);
  const sending = send(shot);
  for (let i = 0; !deliveries().length && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(deliveries()).toHaveLength(1);
  ipc.emit("openteam:screenbot:delivered", event(main), {
    requestId: deliveries()[0]!.payload.requestId,
    ok: false,
    error: "Owned failure",
  });
  expect(await sending).toEqual({ ok: false, error: "Owned failure" });
  expect(subject.capture.id).toBe(shot.id);
  expect(subject.draft).toBe("Retry words");
  expect(discarded).toEqual(staged);
});

test("foreign windows and overlay subframes cannot reveal, draft, or send", async () => {
  const shot = await take();
  const outsider = new FakeWindow();
  ipc.emit("openteam:screenbot:roster", event(outsider), {
    accountScope: "foreign",
    bots: [],
    dictation: false,
  });
  expect(subject.capture.id).toBe(shot.id);
  const wrong = { sender: subject.overlay.webContents, senderFrame: {} };
  ipc.emit("screenbot:draft", wrong, { draft: "foreign", shotId: shot.id, accountScope: "A" });
  await expect(
    ipc.handles.get("screenbot:send")!(wrong, { shotId: shot.id, botId: bot.id, content: "x" })
  ).rejects.toThrow("unavailable");
  expect(subject.draft).toBe("");
});

test("reload abandons requests and releases account images; dispose removes listeners", async () => {
  const shot = await take();
  draft("Private A", shot);
  subject.abandonRequests();
  expect(subject.capture).toBeNull();
  expect(subject.draft).toBe("");
  roster("B");
  await take();
  const ownedOverlay = overlay();
  subject.dispose();
  expect(subject.capture).toBeNull();
  expect(ownedOverlay.destroyed).toBe(true);
  expect(ipc.listenerCount("openteam:screenbot:roster")).toBe(0);
  expect(ipc.handles.size).toBe(0);
});

// Exercise the actual renderer callback, including its await before IPC.
const rendererSource = await Bun.file(new URL("../../src/renderer/screenbot/screenbot-app.tsx", import.meta.url)).text();
const transcriberStart = rendererSource.indexOf("  const transcribeViaApp = ");
const transcriberEnd = rendererSource.indexOf("  const sendAfterDictation", transcriberStart);
if (transcriberStart < 0 || transcriberEnd < 0) throw new Error("ScreenBot transcriber not found");
const transcriberBody = rendererSource.slice(transcriberStart, transcriberEnd).trim().replace(/^const transcribeViaApp = /, "return ");
const makeTranscriber = new Function("useCallback", "accountScope", "accountEpoch", "shotRef", "bridge",
  new Bun.Transpiler({ loader: "ts" }).transformSync(transcriberBody));
const respondToAudio = () => {
  const originalSend = main.webContents.send;
  main.webContents.send = (channel: string, payload: any) => {
    originalSend(channel, payload);
    if (channel === "openteam:screenbot:transcribe") queueMicrotask(() =>
      ipc.emit("openteam:screenbot:delivered", event(main), { requestId: payload.requestId, ok: true, text: "Retained words" }));
  };
};
const transcribeAudio = (audio: Uint8Array, mimeType: string, shotId: string, accountScope: string) =>
  ipc.handles.get("screenbot:transcribe")!(event(overlay()), { audio, mimeType, shotId, accountScope });

test("pending dictation conversion survives same-account retakes", async () => {
  const first = await take();
  const bytes = deferred<ArrayBuffer>();
  const shot = { current: { id: first.id } };
  respondToAudio();
  const transcribe = makeTranscriber((fn: any) => fn, { current: "A" }, { current: 1 }, shot, () => ({ transcribe: transcribeAudio }));
  const pending = transcribe({ type: "audio/webm", arrayBuffer: () => bytes.promise }, new AbortController().signal);
  await take();
  const latest = await take();
  shot.current = { id: latest.id };
  bytes.resolve(new Uint8Array([1]).buffer);
  expect(await pending).toEqual({ text: "Retained words" });
});

test("pending dictation conversion cancels across account replacement before IPC", async () => {
  const first = await take(), bytes = deferred<ArrayBuffer>();
  const epoch = { current: 1 }, scope = { current: "A" };
  let calls = 0;
  const transcribe = makeTranscriber((fn: any) => fn, scope, epoch, { current: { id: first.id } }, () => ({
    transcribe: () => { calls++; return Promise.resolve({ ok: true, text: "Forbidden" }); },
  }));
  const pending = transcribe({ type: "audio/webm", arrayBuffer: () => bytes.promise }, new AbortController().signal)
    .then(() => "unexpected success", (error: Error) => error.name);
  roster("B"); epoch.current++; scope.current = "B";
  bytes.resolve(new Uint8Array([1]).buffer);
  expect(await pending).toBe("AbortError");
  expect(calls).toBe(0);
});

test("closed composers and unknown shot ids cannot submit old recordings", async () => {
  const first = await take();
  subject.hideOverlay();
  await take();
  for (const shotId of [first.id, "unknown-shot"]) {
    expect((await transcribeAudio(new Uint8Array([1]), "audio/webm", shotId, "A")).ok).toBe(false);
  }
  expect(traffic.filter(item => item.channel === "openteam:screenbot:transcribe")).toHaveLength(0);
});
