import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CdpConnection, type JsonObject } from "./cdp-connection";
import { asCookie, type BrowserCookie, cookieKey, cookieMap, cookieParameter } from "./cookies";
import { browserJsonChunks, browserJsonExceeds } from "./json-chunks";
import { readBrowserAuthority } from "./authority-reader";
import {
  authorityPartName,
  joinAuthorityParts,
  PART_NAME,
  splitAuthorityParts,
  writeEncryptedAuthority,
} from "./authority-parts";
import {
  BROWSER_STATE_EXPORT_EXPRESSION,
  BROWSER_STATE_IMPORT_FUNCTION,
  type BrowserOriginState,
  originForUrl,
  stateDigest,
} from "./origin-state";

interface Peer {
  botId: string;
  port: number;
  profileDirectory: string;
  cdp: CdpConnection;
  baseline: Map<string, BrowserCookie>;
  targets: Map<string, BrowserTarget>;
  originBaselines: Map<string, string>;
  // A busy page or short CPU stall can time out a call while the socket stays
  // open. Such a peer is kept and retried; `stale` marks that it missed changes.
  unresponsive: boolean;
  stale: boolean;
}

interface BrowserTarget {
  targetId: string;
  sessionId: string;
  origin: string;
  browserContextId?: string;
}

const storageGroup = (target: BrowserTarget): string =>
  JSON.stringify([target.browserContextId ?? "", target.origin]);

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
  private readonly partsDirectory: string;
  private previousParts = new Set<string>();
  private loaded = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncTail: Promise<void> = Promise.resolve();
  private periodicSync: Promise<void> | null = null;
  private saveTail: Promise<void> = Promise.resolve();
  private savedDigest: string | null = null;

  constructor(
    home = process.env.HOME ?? "/home/openteam",
    private readonly detachSyncTimeoutMs = 5_000
  ) {
    this.stateDirectory = join(home, ".openteam");
    this.keyPath = join(this.stateDirectory, "browser-authority.key");
    this.storePath = join(this.stateDirectory, "browser-authority.json.enc");
    this.partsDirectory = join(this.stateDirectory, "browser-authority.parts");
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
    const peer = this.peers.get(botId);
    if (!peer) return;
    // Final live-state sharing is best effort. An unrelated unresponsive page
    // must not prevent the screen owner from stopping its processes and freeing
    // memory. The on-disk browser profile is retained by the screen lifecycle.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.enqueueSync(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Browser detach sync timed out")), this.detachSyncTimeoutMs);
        }),
      ]);
    } catch {
      console.warn("Browser live-state sync did not finish during detach; retaining the on-disk profile.");
    } finally {
      clearTimeout(timeout);
      if (this.peers.get(botId) === peer) {
        this.peers.delete(botId);
        peer.cdp.close();
      }
      this.stopTimerIfIdle();
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
      unresponsive: false,
      stale: false,
    };
    this.peers.set(botId, peer);
    await this.setCookies(peer, [...this.cookies.values()]);
    peer.baseline = await this.readCookies(peer.cdp);
    await peer.cdp.call("Target.setDiscoverTargets", { discover: true });
    await this.refreshTargets(peer, true);
    await this.save();
    if (!this.timer) {
      this.timer = setInterval(() => this.schedulePeriodicSync(), 1_500);
      this.timer.unref?.();
    }
  }

  private schedulePeriodicSync(): void {
    // Slow pages must not accumulate a new whole-browser reconciliation on
    // every timer tick. Explicit detach requests still get their own barrier.
    if (this.periodicSync) return;
    const pending = this.enqueueSync();
    this.periodicSync = pending;
    const clear = () => {
      if (this.periodicSync === pending) this.periodicSync = null;
    };
    void pending.then(clear, clear);
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
    // A peer that fails is skipped for the rest of the pass, so its baseline
    // still holds its own changes when it answers again.
    const failed = new Set<Peer>();
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
        this.peerFailed(peer);
        failed.add(peer);
      }
    }
    for (const key of updates.keys()) deletions.delete(key);
    const changedOrigins = new Map<string, BrowserOriginState>();
    const observedStates = new Map<Peer, Map<string, string>>();
    for (const peer of [...this.peers.values()]) {
      if (failed.has(peer)) continue;
      try {
        await this.refreshTargets(peer, false);
        const observed = new Map<string, string>();
        observedStates.set(peer, observed);
        for (const target of peer.targets.values()) {
          const group = storageGroup(target);
          if (observed.has(group)) continue;
          const snapshot = await this.readOriginState(peer, target);
          if (!snapshot) continue;
          const digest = stateDigest(snapshot);
          // A failed/closing tab must leave another tab available for retry.
          observed.set(group, digest);
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
        this.peerFailed(peer);
        failed.add(peer);
      }
    }
    const changed = updates.size > 0 || deletions.size > 0 || changedOrigins.size > 0;
    for (const [key, cookie] of updates) this.cookies.set(key, cookie);
    for (const key of deletions.keys()) this.cookies.delete(key);
    const changedDigests = new Map(
      [...changedOrigins].map(([origin, snapshot]) => [origin, stateDigest(snapshot)])
    );
    for (const peer of [...this.peers.values()]) {
      if (failed.has(peer) || (!changed && !peer.stale)) continue;
      try {
        if (peer.stale) {
          // Catch up on everything shared while this browser was not answering.
          for (const [key, cookie] of peer.baseline) {
            if (!this.cookies.has(key)) await this.deleteCookie(peer, cookie);
          }
          await this.setCookies(
            peer,
            [...this.cookies]
              .filter(([key, cookie]) => JSON.stringify(peer.baseline.get(key)) !== JSON.stringify(cookie))
              .map(([, cookie]) => cookie)
          );
        } else {
          for (const cookie of deletions.values()) await this.deleteCookie(peer, cookie);
          await this.setCookies(peer, [...updates.values()]);
        }
        peer.baseline = await this.readCookies(peer.cdp);
        for (const [origin, snapshot] of changedOrigins) {
          const applied = new Set<string>();
          for (const target of peer.targets.values()) {
            if (target.origin !== origin) continue;
            const group = storageGroup(target);
            if (applied.has(group)) continue;
            // The originating browser already has this state. Reimporting it
            // clears/rebuilds its IndexedDB and cache data unnecessarily.
            if (observedStates.get(peer)?.get(group) === changedDigests.get(origin)) {
              applied.add(group);
              continue;
            }
            if (!(await this.writeOriginState(peer, target, snapshot))) continue;
            const restored = await this.readOriginState(peer, target);
            if (restored) {
              const restoredDigest = stateDigest(restored);
              if (restoredDigest === changedDigests.get(origin)) applied.add(group);
              peer.originBaselines.set(origin, restoredDigest);
            }
          }
        }
        peer.stale = false;
      } catch {
        this.peerFailed(peer);
        failed.add(peer);
      }
    }
    for (const peer of [...this.peers.values()]) {
      if (!failed.has(peer)) {
        this.peerAnswered(peer);
      } else if (changed) {
        peer.stale = true;
        // Without a baseline, the next target refresh restores the shared state.
        for (const origin of changedOrigins.keys()) peer.originBaselines.delete(origin);
      }
    }
    if (changed) await this.save();
  }

  private peerFailed(peer: Peer): void {
    if (peer.cdp.closed) {
      if (this.peers.get(peer.botId) === peer) this.peers.delete(peer.botId);
      peer.cdp.close();
      this.stopTimerIfIdle();
      console.warn(`Browser for bot ${peer.botId} closed its DevTools connection; stopped sharing its sign-ins.`);
      return;
    }
    if (!peer.unresponsive) {
      console.warn(`Browser for bot ${peer.botId} is not answering; retrying sign-in sharing.`);
    }
    peer.unresponsive = true;
  }

  private peerAnswered(peer: Peer): void {
    if (!peer.unresponsive) return;
    peer.unresponsive = false;
    console.info(`Browser for bot ${peer.botId} is answering again; sign-in sharing resumed.`);
  }

  private stopTimerIfIdle(): void {
    if (this.peers.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refreshTargets(peer: Peer, restoreAuthority: boolean): Promise<void> {
    const result = await peer.cdp.call<{
      targetInfos?: Array<{ targetId?: string; type?: string; url?: string; browserContextId?: string }>;
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
        target = { targetId: info.targetId, sessionId: attached.sessionId, origin, browserContextId: info.browserContextId };
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
      if (browserJsonExceeds(state, 64 * 1024 * 1024)) return null;
      return state;
    } catch {
      return null;
    }
  }

  private async writeOriginState(
    peer: Peer,
    target: BrowserTarget,
    state: BrowserOriginState
  ): Promise<boolean> {
    if (state.origin !== target.origin) return false;
    const expression = `(${BROWSER_STATE_IMPORT_FUNCTION})(${JSON.stringify(state)})`;
    try {
      const evaluated = await peer.cdp.call<{ exceptionDetails?: unknown; result?: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: false,
        },
        target.sessionId
      );
      return !evaluated.exceptionDetails && evaluated.result?.value === true;
    } catch {
      // A page can navigate or close while its origin state is being restored.
      return false;
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
      const plaintext = await readBrowserAuthority(this.storePath, key);
      this.savedDigest = createHash("sha256").update(key).update(plaintext, "utf8").digest("hex");
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
        const readPart = async (name: string): Promise<unknown> => {
          const part = await readBrowserAuthority(join(this.partsDirectory, name), key);
          if (authorityPartName(key, [part]) !== name) throw new Error("Browser authority part mismatch");
          this.previousParts.add(name);
          return JSON.parse(part);
        };
        for (const [origin, value] of Object.entries(unpacked.origins)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const state: Record<string, unknown> = {};
          for (const [field, item] of Object.entries(value)) {
            try {
              state[field] = await joinAuthorityParts(item, readPart);
            } catch {
              // Restore never touches a storage area whose saved copy is
              // incomplete; the browser keeps its own data for it.
            }
          }
          if (state.origin === origin && originForUrl(origin) === origin)
            this.origins.set(origin, state as BrowserOriginState);
        }
      }
    } catch {
      // The first launch has no authority store. A corrupt store is safely ignored.
    }
    this.loaded = true;
  }

  private save(): Promise<void> {
    // Streaming yields during serialization. Serialize writers so a slower,
    // older save cannot replace a newer authority file.
    const pending = this.saveTail.then(() => this.saveNow());
    this.saveTail = pending.catch(() => undefined);
    return pending;
  }

  private async saveNow(): Promise<void> {
    const persistent = [...this.cookies.values()].filter(
      (cookie) => typeof cookie.expires === "number" && cookie.expires > 0
    );
    // Freeze map membership before the first await. Reconciliation replaces
    // snapshot objects; their nested data is immutable while being saved.
    const origins = [...this.origins];
    const key = await this.key();
    const parts = new Map<string, unknown>();
    const snapshot = {
      version: 3,
      cookies: persistent,
      origins: Object.fromEntries(
        origins.map(([origin, state]) => [origin, splitAuthorityParts(state, key, parts).value])
      ),
    };
    await mkdir(this.partsDirectory, { recursive: true, mode: 0o700 });
    const existing = new Set(
      (await readdir(this.partsDirectory)).filter((name) => PART_NAME.test(name))
    );
    for (const [name, value] of parts) {
      if (existing.has(name)) continue;
      await writeEncryptedAuthority(
        join(this.partsDirectory, name),
        browserJsonChunks(value),
        key,
        this.stateDirectory,
        "browser-authority.part"
      );
    }
    // Every save uses a fresh IV, so rewriting unchanged state still changes the
    // file and makes each box-store snapshot keep another encrypted copy.
    const hash = createHash("sha256").update(key);
    for (const chunk of browserJsonChunks(snapshot)) hash.update(chunk, "utf8");
    const plaintextDigest = hash.digest("hex");
    if (plaintextDigest !== this.savedDigest || !(await stat(this.storePath).catch(() => null))) {
      await writeEncryptedAuthority(
        this.storePath,
        browserJsonChunks(snapshot),
        key,
        this.stateDirectory,
        "browser-authority.json.enc"
      );
      this.savedDigest = plaintextDigest;
    }
    // A box-store snapshot can read the index and the parts directory at
    // slightly different times, so the previous index's parts stay one more
    // generation.
    for (const name of existing) {
      if (!parts.has(name) && !this.previousParts.has(name)) {
        await rm(join(this.partsDirectory, name), { force: true });
      }
    }
    this.previousParts = new Set(parts.keys());
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
