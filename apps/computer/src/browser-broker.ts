import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

interface BrowserCookie extends JsonObject {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  session?: boolean;
  partitionKey?: JsonObject;
  partitionKeyOpaque?: boolean;
}

interface Peer {
  botId: string;
  port: number;
  cdp: CdpConnection;
  baseline: Map<string, BrowserCookie>;
}

const cookieKey = (cookie: BrowserCookie): string =>
  [cookie.name, cookie.domain, cookie.path, JSON.stringify(cookie.partitionKey ?? null)].join("\0");

const cookieParameter = (cookie: BrowserCookie): JsonObject => {
  const result: JsonObject = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
  };
  for (const key of [
    "secure",
    "httpOnly",
    "sameSite",
    "priority",
    "sameParty",
    "sourceScheme",
    "sourcePort",
  ]) {
    if (cookie[key] !== undefined) result[key] = cookie[key];
  }
  if (typeof cookie.expires === "number" && cookie.expires > 0) result.expires = cookie.expires;
  if (cookie.partitionKey && !cookie.partitionKeyOpaque) result.partitionKey = cookie.partitionKey;
  return result;
};

const asCookie = (value: unknown): BrowserCookie | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as JsonObject;
  if (
    typeof raw.name !== "string" ||
    typeof raw.value !== "string" ||
    typeof raw.domain !== "string" ||
    typeof raw.path !== "string"
  ) {
    return null;
  }
  return raw as BrowserCookie;
};

const cookieMap = (values: unknown[]): Map<string, BrowserCookie> => {
  const result = new Map<string, BrowserCookie>();
  for (const value of values) {
    const cookie = asCookie(value);
    if (cookie) result.set(cookieKey(cookie), cookie);
  }
  return result;
};

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => void this.onMessage(event));
    socket.addEventListener("close", () => this.failPending(new Error("Browser CDP closed")));
    socket.addEventListener("error", () => this.failPending(new Error("Browser CDP failed")));
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Browser CDP connection timed out")),
        2_000
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Browser CDP connection failed"));
        },
        { once: true }
      );
    });
    return new CdpConnection(socket);
  }

  call<T>(method: string, params: JsonObject = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser CDP command timed out: ${method}`));
      }, 2_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.socket.close();
    this.failPending(new Error("Browser CDP disconnected"));
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    const text =
      typeof event.data === "string"
        ? event.data
        : event.data instanceof Blob
          ? await event.data.text()
          : new TextDecoder().decode(event.data as ArrayBuffer);
    const message = JSON.parse(text) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "Browser CDP error"));
    else pending.resolve(message.result);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

/**
 * Shares browser authentication at the computer boundary without letting two
 * Chromium processes write the same profile. Each bot keeps its own UI/profile;
 * this broker reconciles cookies through each browser's local DevTools socket.
 */
export class BrowserBroker {
  private readonly peers = new Map<string, Peer>();
  private readonly attaching = new Map<string, Promise<void>>();
  private readonly cookies = new Map<string, BrowserCookie>();
  private readonly stateDirectory: string;
  private readonly keyPath: string;
  private readonly storePath: string;
  private loaded = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncTail: Promise<void> = Promise.resolve();

  constructor(home = process.env.HOME ?? "/home/openbot") {
    this.stateDirectory = join(home, ".openbot");
    this.keyPath = join(this.stateDirectory, "browser-authority.key");
    this.storePath = join(this.stateDirectory, "browser-authority.json.enc");
  }

  attach(botId: string, port: number, attempts = 1): Promise<void> {
    if (this.peers.has(botId)) return Promise.resolve();
    const current = this.attaching.get(botId);
    if (current) {
      // A screen-status probe may already be doing a single non-blocking
      // discovery attempt while Chromium is launching. A launch-triggered
      // caller with retries must get a fresh attempt after that probe settles.
      return attempts > 1 ? current.then(() => this.attach(botId, port, attempts)) : current;
    }
    const pending = this.attachInner(botId, port, attempts).finally(() => {
      this.attaching.delete(botId);
    });
    this.attaching.set(botId, pending);
    return pending;
  }

  async detach(botId: string): Promise<void> {
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

  private async attachInner(botId: string, port: number, attempts: number): Promise<void> {
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
    const peer: Peer = { botId, port, cdp, baseline: local };
    this.peers.set(botId, peer);
    await this.setCookies(peer, [...this.cookies.values()]);
    peer.baseline = await this.readCookies(peer.cdp);
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
    if (updates.size === 0 && deletions.size === 0) return;
    for (const [key, cookie] of updates) this.cookies.set(key, cookie);
    for (const key of deletions.keys()) this.cookies.delete(key);
    for (const peer of [...this.peers.values()]) {
      try {
        for (const cookie of deletions.values()) await this.deleteCookie(peer, cookie);
        await this.setCookies(peer, [...updates.values()]);
        peer.baseline = await this.readCookies(peer.cdp);
      } catch {
        this.peers.delete(peer.botId);
        peer.cdp.close();
      }
    }
    await this.save();
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
      for (const value of JSON.parse(plaintext) as unknown[]) {
        const cookie = asCookie(value);
        if (cookie) this.cookies.set(cookieKey(cookie), cookie);
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
      cipher.update(JSON.stringify(persistent), "utf8"),
      cipher.final(),
    ]);
    await writeFile(
      this.storePath,
      JSON.stringify({
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: encrypted.toString("base64"),
      }),
      { mode: 0o600 }
    );
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
