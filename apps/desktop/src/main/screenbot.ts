import { randomUUID } from "node:crypto";
import {
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  screen,
  shell,
  systemPreferences,
  type Display,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type NativeImage,
} from "electron";

import { encodeScreenPng } from "./screenbot-png";
import { isRecord, parseScreenBotRoster, text, type ScreenBotRoster } from "./screenbot-roster";

export type { ScreenBotBot, ScreenBotRoster } from "./screenbot-roster";

/** Over 25 MB the server rejects an attachment, so a huge PNG falls back to JPEG. */
const MAX_PNG_BYTES = 24 * 1024 * 1024;
/** An idle overlay is kept warm for the next screenbot, then released. */
const IDLE_RELEASE_MS = 2 * 60_000;
const DELIVERY_TIMEOUT_MS = 20_000;
/** The longest message that goes with a ScreenBot (the composer stops there too). */
const MAX_CONTENT = 100_000;
const PRESS_COALESCE_MS = 300;
/** The overlay's intro; a retake waits until the composer is up. */
const INTRO_MS = 1_650;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
/** Matches the voice note limit the server accepts. */
const MAX_DICTATION_BYTES = 25 * 1024 * 1024;
// More than the maximum 300 ms retakes during a five-minute recording; IDs only.
const MAX_DICTATION_SHOTS = 1024;

export interface ScreenBotShot {
  id: string;
  accountScope: string;
  /** JPEG of the display, decoded once and shared by every layer of the overlay. */
  image: Uint8Array;
  width: number;
  height: number;
  /** Where the display sits inside the overlay, if macOS moved the window. */
  offsetX: number;
  offsetY: number;
  /** The display's work area (no menu bar or Dock), in overlay coordinates. */
  workArea: { x: number; y: number; width: number; height: number };
  roster: ScreenBotRoster;
  rosterVersion: number;
  draft: string;
}

export type ScreenBotSendResult = { ok: true; botName: string } | { ok: false; error: string };

interface DeliveryReply {
  requestId: string;
  ok: boolean;
  error?: string;
  text?: string;
  /** No answer came (timeout, or the chat window went away): it may still have acted. */
  unanswered?: boolean;
}

interface Capture {
  id: string;
  accountEpoch: number;
  display: Display;
  image: NativeImage;
  png: Promise<EncodedShot> | null;
  /** Cancels the PNG encode when the shot is dropped (closed or retaken) before it is sent. */
  encoding: AbortController;
  sending: boolean;
}

interface EncodedShot { bytes: Uint8Array; mimeType: string; fileName: string; width: number; height: number }

/** Full quality for the Bot, encoded off the main thread so the overlay keeps every frame. */
const pngFor = async (image: NativeImage, signal: AbortSignal): Promise<EncodedShot> => {
  const { width, height } = image.getSize();
  const png = await encodeScreenPng(image.toBitmap(), width, height, "bgra", signal);
  if (png.byteLength <= MAX_PNG_BYTES) return { bytes: png, mimeType: "image/png", fileName: "Screenshot.png", width, height };
  return { bytes: image.toJPEG(92), mimeType: "image/jpeg", fileName: "Screenshot.jpg", width, height };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SCREEN_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export interface DesktopScreenBotOptions {
  preloadPath: string;
  /** Loads the overlay page: the Vite server in development, the bundle otherwise. */
  loadPage: (window: BrowserWindow) => Promise<void>;
  mainWindow: () => BrowserWindow | null;
  focusMainWindow: () => void;
  /** Writes the shot into the durable-send staging area, so its bytes never cross to a renderer. */
  stageDelivery: (stagingId: string, bytes: Uint8Array) => Promise<void>;
  discardDelivery: (stagingId: string) => Promise<void>;
}

/**
 * ScreenBot: a hotkey captures the display under the pointer, and a floating composer on top
 * of every app sends the shot to a Bot. The overlay is one transparent, click-through panel
 * the size of the display, so its animations can travel anywhere on screen. Delivery runs in
 * the signed-in main window, through the same durable send path as the chat composer.
 */
export class DesktopScreenBot {
  private overlay: BrowserWindow | null = null;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];
  private overlayLoading: Promise<BrowserWindow> | null = null;
  private roster: ScreenBotRoster = { bots: [], dictation: false };
  /** Increases with every roster the main window publishes, so an older one never wins. */
  private rosterVersion = 0;
  private capture: Capture | null = null;
  private accountScope: string | null = null;
  private accountEpoch = 0;
  /** Retakes keep dictation in this open composer; close/auth reset revokes it. */
  private readonly dictationShots = new Set<string>();
  private capturing = false;
  private lastPressAt = -Infinity;
  private shownAt = -Infinity;
  private draft = "";
  private draftShotId: string | null = null;
  /** A shot was sent to the overlay and not yet revealed: the only time "ready" may show it. */
  private awaitingReveal = false;
  /** One transcription at a time. */
  private transcribing = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deliveries = new Map<string, (reply: DeliveryReply) => void>();
  /** Stage timings of the latest screenbot, logged with OPENTEAM_SCREENBOT_DEBUG=1. */
  private timing: Record<string, number> = {};
  private mark(stage: string) {
    this.timing[stage] = Math.round((performance.now() - (this.timing.pressed ?? performance.now())) * 10) / 10;
  }

  constructor(private readonly options: DesktopScreenBotOptions) {
    const listen = <Args extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: Args) => void) => {
      ipcMain.on(channel, listener);
      this.cleanups.push(() => ipcMain.removeListener(channel, listener));
    };
    const handle = (channel: string, listener: (event: IpcMainInvokeEvent, request: unknown) => unknown) => {
      ipcMain.handle(channel, listener);
      this.cleanups.push(() => ipcMain.removeHandler(channel));
    };
    listen("openteam:screenbot:roster", this.onRoster);
    listen("openteam:screenbot:delivered", this.onDelivered);
    // The overlay can only show itself for a shot main just gave it, and only take clicks or
    // focus while that shot is on screen: a misbehaving page can't float over everything.
    listen("screenbot:ready", this.fromOverlay((_event, shotId: unknown) => {
      if (!this.awaitingReveal || !this.capture || this.capture.id !== shotId) return;
      this.awaitingReveal = false;
      this.reveal();
    }));
    listen("screenbot:interactive", this.fromOverlay((_event, interactive: unknown) => {
      const overlay = this.overlay;
      if (!overlay) return;
      overlay.setIgnoreMouseEvents(!(interactive === true && overlay.isVisible() && this.capture), { forward: true });
    }));
    listen("screenbot:focus", this.fromOverlay(() => {
      if (this.overlay?.isVisible() && this.capture) this.overlay.focus();
    }));
    listen("screenbot:draft", this.fromOverlay((_event, value: unknown) => {
      if (!isRecord(value) || value.accountScope !== this.accountScope || value.shotId !== this.draftShotId) return;
      this.draft = text(value.draft, 100_000) ?? "";
    }));
    // A close that finishes after a new shot arrived belongs to the old shot: ignore it.
    listen("screenbot:closed", this.fromOverlay((_event, shotId: unknown) => {
      if (!this.capture || this.capture.id === shotId) this.hideOverlay();
    }));
    listen("screenbot:open-chat", this.fromOverlay((_event, value: unknown) => {
      if (!isRecord(value) || value.accountScope !== this.accountScope) return;
      const bot = this.roster.bots.find((candidate) => candidate.id === value.botId);
      if (!bot) return;
      this.hideOverlay();
      this.options.focusMainWindow();
      // The same navigation as a notification: open the chat at its newest message.
      this.options.mainWindow()?.webContents.send("openteam:notification-click", { channelId: bot.channelId });
    }));
    handle("screenbot:transcribe", async (event, request: unknown) => {
      if (!this.ownsSender(event)) throw new Error("ScreenBot is unavailable");
      return this.transcribe(request);
    });
    handle("screenbot:send", async (event, request: unknown) => {
      if (!this.ownsSender(event)) throw new Error("ScreenBot is unavailable");
      return this.send(request);
    });
  }

  /** Lets the app quit once its main window closes on Windows and Linux. */
  closeOverlay() {
    this.dictationShots.clear();
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.awaitingReveal = false;
    this.overlay?.destroy();
    this.overlay = null;
    this.dropCapture();
  }

  /** Lets go of the current shot, cancelling its PNG encode unless it is being sent. */
  private dropCapture() {
    const capture = this.capture;
    this.capture = null;
    if (capture && !capture.sending) capture.encoding.abort();
  }

  /** The chat window reloaded or crashed: nothing it was asked will be answered, so fail now
   * instead of after the timeout. */
  abandonRequests() {
    this.resetAccount(null);
  }

  /** Auth replacement and page teardown revoke all transient work, including in-flight sends. */
  private resetAccount(scope: string | null) {
    this.accountEpoch += 1;
    this.accountScope = scope;
    this.draft = "";
    this.draftShotId = null;
    this.awaitingReveal = false;
    this.capture?.encoding.abort();
    this.dropCapture();
    this.overlay?.webContents.send("screenbot:reset");
    this.hideOverlay();
    this.transcribing = false;
    for (const resolve of [...this.deliveries.values()]) {
      resolve({ requestId: "", ok: false, unanswered: true, error: "ScreenBot account changed. Take the screenshot again." });
    }
    this.roster = { bots: [], dictation: false };
    this.rosterVersion += 1;
  }

  dispose() {
    this.disposed = true;
    this.resetAccount(null);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.deliveries.clear();
    this.closeOverlay();
  }

  async take(): Promise<void> {
    // Spam-safe: one capture at a time, presses 300 ms apart coalesce, and a press during the
    // intro is ignored. Once the composer is up, a press retakes the screen (keeping the draft).
    const now = performance.now();
    if (this.disposed || this.capturing || now - this.lastPressAt < PRESS_COALESCE_MS) return;
    if (this.overlay?.isVisible() && now - this.shownAt < INTRO_MS) return;
    if (!this.accountScope) { this.options.focusMainWindow(); return; }
    const accountScope = this.accountScope;
    const epoch = this.accountEpoch;
    const current = () => epoch === this.accountEpoch && accountScope === this.accountScope;
    this.lastPressAt = now;
    this.capturing = true;
    this.timing = { pressed: performance.now() };
    try {
      // Refresh the Bot list while the screen is captured; the overlay updates if it changed.
      this.options.mainWindow()?.webContents.send("openteam:screenbot:roster-request");
      if (!(await this.ensureScreenAccess()) || !current()) return;
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      // A second screenbot retakes the screen without the floating composer in it.
      if (this.overlay?.isVisible()) {
        this.overlay.setOpacity(0);
        await delay(80);
        if (!current()) return;
      }
      // A cold overlay loads its page while the screen is captured, not after.
      const overlayReady = this.prepareOverlay();
      overlayReady.catch(() => undefined);
      const image = await this.captureDisplay(display);
      if (!current()) return;
      this.mark("captured");
      if (!image) {
        this.overlay?.setOpacity(1);
        this.releaseIfHidden();
        await this.explainMissingAccess();
        return;
      }
      // Checked after the capture: the list asked for above has had time to arrive (main
      // forgets it whenever the chat window reloads).
      if (this.roster.bots.length === 0) {
        // Nothing to send to until the main window has signed in and loaded its Bots.
        this.overlay?.setOpacity(1);
        this.releaseIfHidden();
        this.options.focusMainWindow();
        return;
      }
      this.dropCapture();
      this.capture = { id: randomUUID(), accountEpoch: epoch, display, image, png: null, encoding: new AbortController(), sending: false };
      this.dictationShots.add(this.capture.id);
      if (this.dictationShots.size > MAX_DICTATION_SHOTS) this.dictationShots.delete(this.dictationShots.values().next().value!);
      this.draftShotId = this.capture.id;
      const overlay = await overlayReady;
      if (!current() || !this.capture) return;
      this.mark("overlayReady");
      overlay.setBounds(display.bounds);
      const bounds = overlay.getBounds();
      const scale = display.scaleFactor;
      const shot: ScreenBotShot = {
        id: this.capture.id,
        accountScope,
        // A Buffer is already a Uint8Array: no extra copy before IPC.
        image: image.toJPEG(90),
        width: Math.round(image.getSize().width / scale) || display.bounds.width,
        height: Math.round(image.getSize().height / scale) || display.bounds.height,
        offsetX: display.bounds.x - bounds.x,
        offsetY: display.bounds.y - bounds.y,
        workArea: {
          x: display.workArea.x - bounds.x,
          y: display.workArea.y - bounds.y,
          width: display.workArea.width,
          height: display.workArea.height,
        },
        roster: this.roster,
        rosterVersion: this.rosterVersion,
        draft: this.draft,
      };
      this.mark("encoded");
      // Full frame rate for the intro; throttled again once hidden.
      overlay.webContents.setBackgroundThrottling(false);
      this.awaitingReveal = true;
      overlay.webContents.send("screenbot:shot", shot);
      this.mark("sent");
    } catch (error) {
      if (!current()) return;
      console.error("OpenTeam screenbot failed", error);
      this.overlay?.setOpacity(1);
      this.releaseIfHidden();
    } finally {
      this.capturing = false;
    }
  }

  private async ensureScreenAccess(): Promise<boolean> {
    if (process.platform !== "darwin") return true;
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted" || status === "not-determined") return true;
    await this.explainMissingAccess();
    return false;
  }

  private async explainMissingAccess() {
    if (process.platform !== "darwin") return;
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "Allow OpenTeam to record your screen",
      detail:
        "ScreenBot captures your screen so you can send it to a Bot. Turn on OpenTeam in Privacy & Security › Screen & System Audio Recording, then reopen OpenTeam.",
      buttons: ["Open System Settings", "Not Now"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await shell.openExternal(SCREEN_SETTINGS_URL);
  }

  private async captureDisplay(display: Display): Promise<NativeImage | null> {
    const scale = display.scaleFactor;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    const image = source?.thumbnail;
    return image && !image.isEmpty() ? image : null;
  }

  private prepareOverlay(): Promise<BrowserWindow> {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (this.overlay && !this.overlay.isDestroyed()) return Promise.resolve(this.overlay);
    this.overlayLoading ??= this.createOverlay().finally(() => { this.overlayLoading = null; });
    return this.overlayLoading;
  }

  private async createOverlay(): Promise<BrowserWindow> {
    const darwin = process.platform === "darwin";
    const overlay = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // An NSPanel takes keyboard focus without activating OpenTeam, so the app being
      // captured stays frontmost and the main window stays where it was.
      type: darwin ? "panel" : "toolbar",
      enableLargerThanScreen: true,
      roundedCorners: false,
      hiddenInMissionControl: true,
      acceptFirstMouse: true,
      title: "ScreenBot",
      webPreferences: {
        preload: this.options.preloadPath,
        // Its own storage: the chat window's holds the server address and session, which a
        // page showing screen content has no business reading or changing.
        partition: "persist:screenbot",
        // Hidden between uses: let Chromium throttle it (no frames, slowed timers). Each shot
        // turns throttling off for its intro and composer.
        backgroundThrottling: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: true,
      },
    });
    // Above the menu bar, the Dock and full-screen apps, on every Space.
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.webContents.on("will-navigate", (event) => event.preventDefault());
    // A reloaded or crashed page has lost its shot: never leave an empty panel on screen.
    overlay.webContents.on("did-finish-load", () => { if (overlay.isVisible()) this.hideOverlay(); });
    overlay.webContents.on("render-process-gone", () => this.closeOverlay());
    // File › Close (⌘W) reaches the focused panel: treat it as Esc, so the shot is let go.
    overlay.on("close", (event) => {
      event.preventDefault();
      this.hideOverlay();
    });
    overlay.once("closed", () => {
      if (this.overlay === overlay) this.overlay = null;
    });
    this.overlay = overlay;
    try {
      await this.options.loadPage(overlay);
    } catch (error) {
      // Never reuse a window whose page didn't load.
      if (this.overlay === overlay) this.overlay = null;
      overlay.destroy();
      throw error;
    }
    return overlay;
  }

  private reveal() {
    const overlay = this.overlay;
    if (!overlay) return;
    overlay.setOpacity(1);
    overlay.setIgnoreMouseEvents(true, { forward: true });
    // View › Zoom acts on the focused panel too; the overlay is laid out in screen pixels.
    overlay.webContents.setZoomLevel(0);
    if (!overlay.isVisible()) overlay.showInactive();
    // Key focus without activating the app, so typing goes straight to the composer.
    overlay.focus();
    this.mark("shown");
    this.shownAt = performance.now();
    if (process.env.OPENTEAM_SCREENBOT_DEBUG === "1") {
      const { pressed: _pressed, ...stages } = this.timing;
      console.info("OpenTeam screenbot timing (ms)", JSON.stringify(stages));
    }
    const capture = this.capture;
    // Encode the full-quality copy while the intro plays, ready for an immediate send.
    if (capture && !capture.png) {
      capture.png = pngFor(capture.image, capture.encoding.signal);
      capture.png.catch(() => undefined);
    }
  }

  private hideOverlay() {
    this.dictationShots.clear();
    const overlay = this.overlay;
    this.awaitingReveal = false;
    this.dropCapture();
    if (!overlay) return;
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.hide();
    // Hidden from here (⌘W, opening the chat, a reload): the page must stand down too, or a
    // dictation would keep recording in a hidden window.
    if (!overlay.webContents.isDestroyed()) overlay.webContents.send("screenbot:hidden");
    overlay.webContents.setBackgroundThrottling(true);
    this.armRelease(overlay);
  }

  /** A take that failed after warming the overlay: let go of it again if nothing shows. */
  private releaseIfHidden() {
    const overlay = this.overlay;
    if (!overlay || overlay.isVisible()) return;
    this.dropCapture();
    this.dictationShots.clear();
    this.armRelease(overlay);
  }

  private armRelease(overlay: BrowserWindow) {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      if (this.overlay === overlay && !overlay.isVisible()) {
        overlay.destroy();
        this.overlay = null;
      }
    }, IDLE_RELEASE_MS);
  }

  private async send(value: unknown): Promise<ScreenBotSendResult> {
    if (!isRecord(value)) return { ok: false, error: "This screenshot couldn’t be sent." };
    const botId = text(value.botId, 200);
    const content = typeof value.content === "string" ? value.content : null;
    const shotId = text(value.shotId, 200);
    const capture = this.capture;
    const bot = this.roster.bots.find((candidate) => candidate.id === botId);
    if (!capture || capture.accountEpoch !== this.accountEpoch || capture.id !== shotId || content === null) {
      return { ok: false, error: "Take the screenshot again." };
    }
    if (content.length > MAX_CONTENT) return { ok: false, error: "That message is too long to send with a screenshot." };
    // One send per shot at a time; the duplicate would only write another full-size copy.
    if (capture.sending) return { ok: false, error: "This screenshot is already sending." };
    if (!bot) return { ok: false, error: "That Bot is no longer available." };
    const mainWindow = this.options.mainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: "Open OpenTeam to use ScreenBot." };
    }
    const epoch = this.accountEpoch;
    const accountScope = this.accountScope;
    const current = () => epoch === this.accountEpoch;
    capture.sending = true;
    let reply: DeliveryReply;
    let stagedId: string | null = null;
    try {
      capture.png ??= pngFor(capture.image, capture.encoding.signal);
      const image = await capture.png;
      if (!current()) return { ok: false, error: "Take the screenshot again." };
      // The chat window only needs a reference: the bytes go straight to the staging area
      // the durable send uploads from, and the size is already known.
      const stagingId = randomUUID();
      await this.options.stageDelivery(stagingId, image.bytes);
      stagedId = stagingId;
      if (!current()) {
        await this.options.discardDelivery(stagingId).catch(() => undefined);
        return { ok: false, error: "Take the screenshot again." };
      }
      reply = await this.askMainWindow(mainWindow, "openteam:screenbot:deliver", {
        accountScope,
        botId: bot.id,
        content: content.trim(),
        // One delivery per shot: a retry after a timeout can't send it twice.
        nonce: `screenbot-${capture.id}`,
        staged: { stagingId, fileName: image.fileName, mimeType: image.mimeType, byteSize: image.bytes.byteLength, width: image.width, height: image.height },
      }, DELIVERY_TIMEOUT_MS);
    } catch {
      reply = { requestId: "", ok: false, error: "This screenshot couldn’t be sent." };
    } finally {
      capture.sending = false;
    }
    // Refused: nothing will upload the staged copy, so don't leave it on disk. Unanswered, the
    // chat window may already have queued a send that reads it; a retry is still safe (same
    // nonce), and losing the image would be worse than a leftover file.
    if (!reply.ok && !reply.unanswered && stagedId) void this.options.discardDelivery(stagedId).catch(() => undefined);
    if (!current()) return { ok: false, error: "Take the screenshot again." };
    if (!reply.ok) return { ok: false, error: reply.error || "This screenshot couldn’t be sent." };
    this.draft = "";
    // Delivered: this shot is done and can't be sent again.
    if (this.capture === capture) this.capture = null;
    return { ok: true, botName: bot.name };
  }

  /** One request to the signed-in main window, answered on `openteam:screenbot:delivered`. */
  private askMainWindow(mainWindow: BrowserWindow, channel: string, payload: Record<string, unknown>, timeoutMs: number) {
    const requestId = randomUUID();
    // A page still loading has no listener yet, so the message would be lost and the overlay
    // would wait out the timeout. Never sent, so nothing of it was handed over either.
    if (mainWindow.webContents.isLoadingMainFrame()) {
      return Promise.resolve<DeliveryReply>({ requestId, ok: false, error: "OpenTeam is reloading. Try again in a moment." });
    }
    return new Promise<DeliveryReply>((resolve) => {
      const timer = setTimeout(() => {
        this.deliveries.delete(requestId);
        resolve({ requestId, ok: false, unanswered: true, error: "OpenTeam didn’t respond. Try again." });
      }, timeoutMs);
      this.deliveries.set(requestId, (result) => {
        clearTimeout(timer);
        this.deliveries.delete(requestId);
        resolve(result);
      });
      mainWindow.webContents.send(channel, { requestId, ...payload });
    });
  }

  /** Dictation: the overlay records, the main window (which holds the account) transcribes. */
  private async transcribe(value: unknown): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    if (!isRecord(value) || !(value.audio instanceof Uint8Array) || value.audio.byteLength === 0 || value.audio.byteLength > MAX_DICTATION_BYTES) {
      return { ok: false, error: "That recording couldn’t be used. Try again." };
    }
    const mimeType = text(value.mimeType, 100) ?? "audio/webm";
    if (!mimeType.startsWith("audio/")) return { ok: false, error: "That recording couldn’t be used. Try again." };
    // Only from a composer that's on screen with dictation on, and one at a time.
    if (!this.overlay?.isVisible() || !this.capture || (typeof value.shotId !== "string" || !this.dictationShots.has(value.shotId)) || value.accountScope !== this.accountScope || !this.roster.dictation) return { ok: false, error: "Dictation isn’t available right now." };
    if (this.transcribing) return { ok: false, error: "Still transcribing the last recording." };
    const mainWindow = this.options.mainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: "Open OpenTeam to use dictation." };
    const epoch = this.accountEpoch;
    this.transcribing = true;
    const reply = await this.askMainWindow(mainWindow, "openteam:screenbot:transcribe", { accountScope: this.accountScope, audio: value.audio, mimeType }, TRANSCRIBE_TIMEOUT_MS)
      .finally(() => { if (epoch === this.accountEpoch) this.transcribing = false; });
    if (epoch !== this.accountEpoch) return { ok: false, error: "Dictation was cancelled." };
    if (!reply.ok) return { ok: false, error: reply.error || "Transcription failed. Try again." };
    return { ok: true, text: reply.text ?? "" };
  }

  private readonly onRoster = (event: IpcMainEvent, value: unknown) => {
    if (event.sender !== this.options.mainWindow()?.webContents) return;
    const roster = parseScreenBotRoster(value);
    if (!roster) return;
    if (!isRecord(value)) return;
    const scope = value.accountScope === null ? null : text(value.accountScope, 200);
    if ((scope === null && value.accountScope !== null) || scope === "") return;
    if (scope !== this.accountScope) this.resetAccount(scope);
    // Empty rosters also occur during ordinary refreshes; only auth scope revokes ownership.
    if (!scope) return;
    this.roster = roster;
    this.rosterVersion += 1;
    if (this.overlay?.isVisible()) this.overlay.webContents.send("screenbot:roster", { ...roster, accountScope: this.accountScope, version: this.rosterVersion });
  };

  private readonly onDelivered = (event: IpcMainEvent, value: unknown) => {
    if (event.sender !== this.options.mainWindow()?.webContents || !isRecord(value)) return;
    const requestId = text(value.requestId, 200);
    if (!requestId) return;
    this.deliveries.get(requestId)?.({
      requestId,
      ok: value.ok === true,
      ...(typeof value.error === "string" ? { error: value.error.slice(0, 500) } : {}),
      ...(typeof value.text === "string" ? { text: value.text.slice(0, 100_000) } : {}),
    });
  };

  private ownsSender(event: IpcMainEvent | IpcMainInvokeEvent) {
    const overlay = this.overlay;
    return !!overlay && !overlay.isDestroyed() && event.sender === overlay.webContents
      && event.senderFrame === overlay.webContents.mainFrame;
  }

  private fromOverlay<Args extends unknown[]>(handler: (event: IpcMainEvent, ...args: Args) => void) {
    return (event: IpcMainEvent, ...args: Args) => {
      if (this.ownsSender(event)) handler(event, ...args);
    };
  }
}
