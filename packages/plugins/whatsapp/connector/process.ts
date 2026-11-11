import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { scopedProcessEnvironment } from "@openteam/plugin-sdk";
import release from "./release.json";

export type Settings = ReturnType<typeof settings>;
export function settings(env: Record<string, string | undefined> = process.env, home = homedir(), options: { readOnly?: string; maxMessages?: string } = {}) {
  const accountId = env.OPENTEAM_PLUGIN_ACCOUNT_ID;
  if (!accountId || accountId.length > 200) throw new Error("WhatsApp requires an OpenTeam plugin account ID. Connect the account in Marketplace.");
  const accountKey = createHash("sha256").update(accountId).digest("hex").slice(0, 24);
  const readOnly = options.readOnly ?? env.WHATSAPP_READ_ONLY ?? "false";
  if (!["true", "false"].includes(readOnly)) throw new Error("Read-only access must be true or false.");
  const maxMessages = Number(options.maxMessages ?? env.WHATSAPP_MAX_MESSAGES ?? "100000");
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1000 || maxMessages > 1000000)
    throw new Error("Message storage limit must be between 1,000 and 1,000,000.");
  const mediaRoot = env.WHATSAPP_MEDIA_ROOT || "/workspace";
  if (!isAbsolute(mediaRoot)) throw new Error("The attachment folder must be an absolute path on the bot computer.");
  const legacyRoot = join(home, ".local", "share", "openteam", "whatsapp");
  const legacyStore = join(legacyRoot, accountKey);
  const managed = env.OPENTEAM_PLUGIN_STATE_DIR;
  if (managed !== undefined && (!managed || !isAbsolute(managed)))
    throw new Error("The managed WhatsApp state directory must be absolute.");
  const store = managed ? resolve(managed) : legacyStore;
  const stateRoot = managed ? dirname(store) : legacyRoot;
  return { accountId, accountKey, store, stateRoot, legacyRoot, legacyStore,
    mediaRoot: resolve(mediaRoot), readOnly: readOnly === "true", maxMessages,
    env: scopedProcessEnvironment(env, {
      WACLI_DEVICE_LABEL: "OpenTeam Plugin",
      WACLI_SYNC_MAX_MESSAGES: String(maxMessages), WACLI_SYNC_MAX_DB_SIZE: "512MB",
      WACLI_MEDIA_ROOTS: resolve(mediaRoot),
    }),
  };
}

export async function executableBytes(packageRoot: string, platform: string = process.platform, architecture: string = process.arch) {
  const key = `${platform}-${architecture}`;
  if (!(key in release.binaries)) throw new Error("WhatsApp requires an OpenTeam Linux computer with x64 or arm64 architecture.");
  const binary = release.binaries[key as keyof typeof release.binaries];
  const archive = await readFile(join(packageRoot, binary.path));
  if (archive.length !== binary.compressedSize || createHash("sha256").update(archive).digest("hex") !== binary.compressedSha256)
    throw new Error("WhatsApp binary archive verification failed. Reinstall the plugin.");
  const bytes = brotliDecompressSync(archive, { maxOutputLength: binary.size });
  if (bytes.length !== binary.size || createHash("sha256").update(bytes).digest("hex") !== binary.sha256)
    throw new Error("WhatsApp executable verification failed. Reinstall the plugin.");
  return bytes;
}

export async function installExecutable(packageRoot: string, home = homedir()) {
  const bytes = await executableBytes(packageRoot);
  const directory = join(home, ".cache", "openteam", "whatsapp", release.version);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, "wacli");
  // Never execute cached bytes without comparing them with the verified package.
  const cached = await readFile(destination).catch(() => null);
  if (!cached?.equals(bytes)) {
    const temporary = join(directory, `wacli-${randomUUID()}`);
    await writeFile(temporary, bytes, { mode: 0o700, flag: "wx" });
    await rename(temporary, destination);
  }
  await chmod(destination, 0o700);
  return destination;
}

export type Event = { event: string; data?: Record<string, unknown>; ts?: number };
export type Running = { done: Promise<number | null>; stop: () => Promise<void> };
export type Execute = (args: string[], readOnly?: boolean, timeoutMs?: number) => Promise<any>;

async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; yield next.value; }
  } finally { reader.releaseLock(); }
}

export class WacliProcess {
  private children = new Set<ReturnType<WacliProcess["launch"]>>();
  private closed = false;
  constructor(readonly executable: string, readonly configuration: Settings) {}
  private args(args: string[], readOnly = false, timeoutMs = 45000) {
    return ["--store", this.configuration.store, "--timeout", `${Math.ceil(timeoutMs / 1000)}s`,
      ...(readOnly ? ["--read-only"] : []), ...args];
  }
  private launch(args: string[]) {
    if (this.closed) throw new Error("WhatsApp connector is shutting down.");
    // A SIGKILL cannot run our close handlers. Bind each native process to the
    // connector's lifetime so an orphan cannot keep the account writer lock.
    // Check PPID after arming the signal to cover death during child startup.
    // Both programs are part of the OpenTeam Linux computer's base system.
    const command = process.platform === "linux"
      ? ["/usr/bin/setpriv", "--pdeathsig", "KILL", "--", "/bin/sh", "-c",
        'test "$PPID" = "$1" || exit 125; shift; exec "$@"',
        "openteam-wacli", String(process.pid), this.executable, ...args]
      : [this.executable, ...args];
    const child = Bun.spawn(command, {
      cwd: this.configuration.store, env: this.configuration.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    this.children.add(child);
    void child.exited.then(() => this.children.delete(child));
    return child;
  }
  execute: Execute = async (args, readOnly = false, timeoutMs = 45000) => {
    const child = this.launch(this.args(["--json", ...args], readOnly, timeoutMs));
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, errorBytes = 0, failure: Error | undefined;
    const kill = (reason: string) => { failure ??= new Error(reason); child.kill("SIGKILL"); };
    const timer = setTimeout(() => kill("WhatsApp command timed out. A write may have gone through; inspect the exact message before retrying."), timeoutMs + 2000);
    try {
      const [code] = await Promise.all([
        child.exited,
        (async () => { for await (const chunk of chunks(child.stdout)) {
          const data = Buffer.from(chunk); outputBytes += data.length;
          if (outputBytes > 4 * 1024 * 1024) kill("WhatsApp response is too large. Narrow the query or reduce the result limit.");
          else stdout.push(data);
        } })(),
        (async () => { for await (const chunk of chunks(child.stderr)) {
          const data = Buffer.from(chunk);
          if (errorBytes < 16000) { stderr.push(data.subarray(0, 16000 - errorBytes)); errorBytes += data.length; }
        } })(),
      ]);
      if (failure) throw failure;
      let value: any;
      try { value = JSON.parse(Buffer.concat(stdout).toString("utf8")); } catch { /* Report a bounded error below. */ }
      if (code !== 0 || value?.success !== true) {
        const detail = typeof value?.error === "string" ? value.error : Buffer.concat(stderr).toString("utf8").trim().slice(0, 2000);
        throw new Error(detail || "WhatsApp command failed without a valid JSON result.");
      }
      // Preserve the upstream envelope, including pagination, source metadata, and store_warning.
      return value;
    } finally { clearTimeout(timer); child.kill(); }
  };
  follow(args: string[], onEvent: (event: Event) => void): Running {
    const child = this.launch(this.args(["--events", ...args]));
    let pending = "";
    const done = Promise.all([
      child.exited,
      (async () => { for await (const _ of chunks(child.stdout)) { /* Discard human output. */ } })(),
      (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of chunks(child.stderr)) {
          pending += decoder.decode(chunk, { stream: true });
          for (;;) {
            const index = pending.indexOf("\n");
            if (index < 0) break;
            const line = pending.slice(0, index); pending = pending.slice(index + 1);
            if (line.length > 65536) { child.kill("SIGKILL"); return; }
            try { const value = JSON.parse(line); if (typeof value?.event === "string") onEvent(value); } catch { /* Never relay raw logs or pairing payloads. */ }
          }
          if (pending.length > 65536) { pending = ""; child.kill("SIGKILL"); return; }
        }
      })(),
    ]).then(([code]) => code).catch(() => { onEvent({ event: "error" }); child.kill("SIGKILL"); return -1; });
    return { done, stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await done; } finally { clearTimeout(timer); }
    } };
  }
  async close() {
    this.closed = true;
    const children = [...this.children];
    for (const child of children) child.kill("SIGTERM");
    const timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 5000);
    try { await Promise.all(children.map((child) => child.exited)); } finally { clearTimeout(timer); }
  }
  async resetRevokedSession() {
    // A remote logout can leave a stale device row when upstream cleanup races
    // process shutdown. Only an explicit new pairing resets marked-revoked keys.
    if (!(await lstat(join(this.configuration.store, "SESSION_REVOKED")).catch(() => null))) return;
    const backup = join(this.configuration.store, `.revoked-${randomUUID()}`);
    await mkdir(backup, { mode: 0o700 });
    const moved: string[] = [];
    try {
      for (const name of ["session.db", "session.db-wal", "session.db-shm"]) {
        try { await rename(join(this.configuration.store, name), join(backup, name)); moved.push(name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch (error) {
      for (const name of moved.reverse()) await rename(join(backup, name), join(this.configuration.store, name));
      throw error;
    }
    // Keep the revocation marker until upstream confirms a new live login.
    // Message history is in wacli.db and is never moved or removed here.
  }
}

async function ownedDirectory(path: string) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink()))
    throw new Error("WhatsApp state must be a directory without symlinks.");
  return info;
}
async function noSymlinks(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Legacy WhatsApp state contains a symlink; migration refused.");
    if (entry.isDirectory()) await noSymlinks(join(path, entry.name));
  }
}

export async function prepareStore(configuration: Settings) {
  await ownedDirectory(configuration.stateRoot);
  await ownedDirectory(configuration.store);
  if (configuration.store !== configuration.legacyStore) {
    await ownedDirectory(configuration.legacyRoot);
    if (await ownedDirectory(configuration.legacyStore)) {
      // Keep SQLite databases, WALs, history, keys and native lock together. A
      // held native writer lock refuses migration rather than forking a store.
      const { dlopen, FFIType } = await import("bun:ffi");
      const lock = await open(join(configuration.legacyStore, "LOCK"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      let library: ReturnType<typeof dlopen<{ flock: { args: [typeof FFIType.i32, typeof FFIType.i32]; returns: typeof FFIType.i32 } }>> | undefined;
      try {
        library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        });
        if (library.symbols.flock(lock.fd, 2 | 4) !== 0)
          throw new Error("The legacy WhatsApp store is in use. Stop its connector before updating.");
        await noSymlinks(configuration.legacyStore);
        if (await ownedDirectory(configuration.store)) {
          if ((await readdir(configuration.store)).length)
            throw new Error("Both managed and legacy WhatsApp stores exist; refusing an ambiguous migration.");
        }
        await mkdir(dirname(configuration.store), { recursive: true, mode: 0o700 });
        // POSIX rename atomically replaces an empty host-created directory.
        // Cross-filesystem migration fails closed without copying private keys.
        await rename(configuration.legacyStore, configuration.store);
      } finally {
        library?.symbols.flock(lock.fd, 8);
        library?.close(); await lock.close();
      }
    }
  }
  await mkdir(configuration.store, { recursive: true, mode: 0o700 });
  await chmod(configuration.store, 0o700);
}

async function outsidePrivateState(configuration: Settings, path: string, message: string) {
  for (const candidate of new Set([configuration.stateRoot, configuration.legacyRoot])) {
    const privateRoot = await realpath(candidate).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!privateRoot) continue;
    const rel = relative(privateRoot, path);
    if (!rel || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new Error(message);
  }
}

/** Resolve symlinks before checking boundaries. Session files are always excluded. */
export async function attachmentPath(configuration: Settings, path: string) {
  if (!isAbsolute(path)) throw new Error("Use an absolute attachment path on the bot computer.");
  const root = await realpath(configuration.mediaRoot);
  const file = await realpath(path);
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("The attachment must be inside the configured attachment folder.");
  await outsidePrivateState(configuration, file, "WhatsApp session files cannot be sent as attachments.");
  const info = await lstat(file);
  if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error("Attachments must be regular files no larger than 100 MiB.");
  return { path: file, size: info.size };
}

export async function downloadPath(configuration: Settings) {
  const root = await realpath(configuration.mediaRoot);
  const base = join(root, "whatsapp");
  await mkdir(base, { recursive: true, mode: 0o700 });
  if ((await lstat(base)).isSymbolicLink()) throw new Error("The WhatsApp download folder must remain inside the attachment folder without symlinks.");
  const directory = join(base, configuration.accountKey);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("The WhatsApp download folder cannot be a symlink.");
  const resolved = await realpath(directory);
  const rel = relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("The WhatsApp download folder must remain inside the attachment folder.");
  await outsidePrivateState(configuration, resolved, "Media cannot be downloaded into the WhatsApp session folder.");
  // The caller never supplies a filename that can traverse the filesystem.
  return join(resolved, randomUUID());
}
