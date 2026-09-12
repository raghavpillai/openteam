import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CdpConnection, type JsonObject } from "./cdp-connection";
import { asCookie, type BrowserCookie, cookieKey, cookieMap, cookieParameter } from "./cookies";
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
}

interface BrowserTarget {
  targetId: string;
  sessionId: string;
  origin: string;
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

  constructor(home = process.env.HOME ?? "/home/openteam") {
    this.stateDirectory = join(home, ".openteam");
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
