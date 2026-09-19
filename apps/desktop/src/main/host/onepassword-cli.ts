import { access, chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import type { NativeCommand } from "./native-command";
import { onePasswordError, type OnePasswordErrorCode } from "@openteam/contracts/saved-logins";

export const MANAGED_ONEPASSWORD_CLI_VERSION = "2.35.0";
export const ONEPASSWORD_SIGNATURE =
  'identifier "com.1password.op" and anchor apple generic and certificate leaf[subject.OU] = "2BUA8C4S2C"';
const MAX_ARCHIVE = 64 * 1024 * 1024;
const SYSTEM_PATHS = ["/opt/homebrew/bin/op", "/usr/local/bin/op", "/usr/bin/op"];

export function onePasswordFailureKind(message: string): OnePasswordErrorCode {
  const text = message.toLowerCase();
  if (/openteam-op-launcher:/.test(text)) return "launcher-error";
  if (
    /service.account limit|maximum number of service accounts|too many service accounts/.test(text)
  )
    return "service-account-limit";
  if (/authorization prompt dismissed|request was denied|authorization denied|rejected/.test(text))
    return "denied";
  if (
    /connecting to desktop app|desktop app not running|cli is not enabled|couldn't connect to the 1password app|no accounts configured/.test(
      text
    )
  )
    return "integration-off";
  if (
    /permission|not allowed|not authorized|not permitted|forbidden|\(403\)|service accounts are (?:only|not) available|must be an (?:owner|administrator)/.test(
      text
    )
  )
    return "permission";
  if (/already exists|\(409\)|conflict/.test(text)) return "conflict";
  if (/etimedout|timed out/.test(text)) return "timeout";
  return "op-error";
}

export function provisioningEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) => !key.startsWith("OP_") && !key.startsWith("DYLD_")
      )
    ),
    OP_CACHE: "false",
    OP_BIOMETRIC_UNLOCK_ENABLED: "true",
    OP_LOAD_DESKTOP_APP_SETTINGS: "false",
  };
}

/** Never expose subprocess stderr (provider failures can contain secrets). */
export const privateCliCommand: NativeCommand = (file, args, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abortCode = () =>
      signal?.reason?.name === "TimeoutError" ? ("timeout" as const) : ("cancelled" as const);
    const child = spawn(file, args, {
      env: provisioningEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const chunks: Buffer[] = [];
    const failures: Buffer[] = [];
    const maxBytes = args.includes("service-account") ? 16 * 1024 : 1024 * 1024;
    let bytes = 0,
      failureBytes = 0,
      timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 180_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Classify privately; never expose raw stderr, even on an unexpected failure.
      const remaining = 64 * 1024 - failureBytes;
      if (remaining > 0) {
        failures.push(chunk.subarray(0, remaining));
        failureBytes += Math.min(remaining, chunk.length);
      }
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(onePasswordError(signal?.aborted ? abortCode() : "op-error"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || bytes > maxBytes)
        reject(
          onePasswordError(
            signal?.aborted
              ? abortCode()
              : timedOut
                ? "timeout"
                : onePasswordFailureKind(Buffer.concat(failures).toString("utf8"))
          )
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

/** Inspect ZIP metadata in memory; no archive paths are ever extracted to disk. */
export function onePasswordExecutable(archive: Uint8Array): Buffer {
  const zip = Buffer.from(archive);
  const invalid = () => new Error("The 1Password CLI archive is invalid");
  if (zip.length < 22 || zip.length > MAX_ARCHIVE) throw invalid();
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (
    end < 0 ||
    end < zip.length - 65557 ||
    zip.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + zip.readUInt16LE(end + 20) !== zip.length ||
    zip.readUInt32LE(end + 4) !== 0 ||
    zip.readUInt16LE(end + 8) !== 2 ||
    zip.readUInt16LE(end + 10) !== 2
  )
    throw invalid();
  let cursor = zip.readUInt32LE(end + 16);
  const start = cursor;
  const seen = new Set<string>();
  let executable: Buffer | undefined;
  for (let index = 0; index < 2; index++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = zip.readUInt16LE(cursor + 8),
      method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20),
      size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28),
      extraLength = zip.readUInt16LE(cursor + 30),
      commentLength = zip.readUInt16LE(cursor + 32);
    const mode = zip.readUInt32LE(cursor + 38) >>> 16;
    const local = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw invalid();
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (
      !["op", "op.sig"].includes(name) ||
      seen.has(name) ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      zip.readUInt16LE(cursor + 34) !== 0 ||
      (mode & 0xf000) === 0xa000 ||
      (mode & 0xf000) === 0x4000 ||
      size < 1 ||
      size > (name === "op" ? MAX_ARCHIVE : 4096) ||
      local + 30 > start ||
      zip.readUInt32LE(local) !== 0x04034b50
    )
      throw invalid();
    const localNameLength = zip.readUInt16LE(local + 26),
      localExtraLength = zip.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (
      dataStart + compressedSize > start ||
      zip.readUInt16LE(local + 6) !== flags ||
      zip.readUInt16LE(local + 8) !== method ||
      zip.subarray(local + 30, local + 30 + localNameLength).toString("utf8") !== name
    )
      throw invalid();
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    let decoded: Buffer;
    try {
      decoded = method === 0 ? data : inflateRawSync(data, { maxOutputLength: size });
    } catch {
      throw invalid();
    }
    if (decoded.length !== size) throw invalid();
    if (name === "op") executable = decoded;
    seen.add(name);
    cursor = next;
  }
  if (!executable || cursor !== end || cursor - start !== zip.readUInt32LE(end + 12))
    throw invalid();
  return executable;
}

export const onePasswordArtifact = (arch: string): string => {
  const architecture = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!architecture) throw new Error("Unsupported macOS architecture for 1Password CLI");
  return `https://cache.agilebits.com/dist/1P/op2/pkg/v${MANAGED_ONEPASSWORD_CLI_VERSION}/op_darwin_${architecture}_v${MANAGED_ONEPASSWORD_CLI_VERSION}.zip`;
};

export async function downloadOnePasswordCli(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<Uint8Array> {
  if (![onePasswordArtifact("arm64"), onePasswordArtifact("x64")].includes(url))
    throw new Error("The 1Password CLI download must use the pinned vendor URL");
  const response = await fetcher(url, { redirect: "error", signal });
  const length = Number(response.headers.get("content-length"));
  if (
    !response.ok ||
    !["application/zip", "application/octet-stream", "binary/octet-stream"].includes(
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""
    ) ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_ARCHIVE ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("The 1Password CLI download could not be verified");
  }
  const reader = response.body.getReader();
  const output = new Uint8Array(length);
  let offset = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.length > length)
        throw new Error("The 1Password CLI download exceeded its declared size");
      output.set(chunk.value, offset);
      offset += chunk.value.length;
    }
    if (offset !== length) throw new Error("The 1Password CLI download was incomplete");
    return output;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface CliOptions {
  dataDir: string;
  launcherPath: string;
  platform?: string;
  arch?: string;
  systemPaths?: string[];
  run?: NativeCommand;
  download?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
}

export class ManagedOnePasswordCli {
  private installing?: { promise: Promise<string>; controller: AbortController; waiters: number };
  private readonly run: NativeCommand;
  readonly managedPath: string;
  constructor(private readonly options: CliOptions) {
    this.run = options.run ?? privateCliCommand;
    const arch = options.arch ?? process.arch;
    this.managedPath = join(
      options.dataDir,
      "onepassword-cli",
      `v${MANAGED_ONEPASSWORD_CLI_VERSION}`,
      arch,
      "op"
    );
  }
  private timeout(signal?: AbortSignal, ms = 15_000) {
    return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(ms)]);
  }
  private async launcher(signal?: AbortSignal) {
    if ((this.options.platform ?? process.platform) !== "darwin")
      throw new Error("Managed 1Password CLI is supported on macOS only");
    const launcher = await realpath(this.options.launcherPath);
    await this.run(
      "/usr/bin/codesign",
      ["--verify", "--strict", '-R=identifier "dev.openteam.op-launcher"', launcher],
      this.timeout(signal)
    );
    return launcher;
  }
  private async verify(path: string, signal?: AbortSignal) {
    const resolved = await realpath(path);
    await access(resolved, constants.X_OK);
    await this.run(
      "/usr/bin/codesign",
      ["--verify", "--strict", `-R=${ONEPASSWORD_SIGNATURE}`, resolved],
      this.timeout(signal)
    );
    return resolved;
  }
  private async version(path: string, launcher: string, signal?: AbortSignal) {
    return (
      await this.run(launcher, [this.options.dataDir, path, "--version"], this.timeout(signal))
    ).trim();
  }
  async resolve(signal?: AbortSignal, requireExpiration = false): Promise<string> {
    const launcher = await this.launcher(signal);
    for (const candidate of this.options.systemPaths ?? SYSTEM_PATHS) {
      try {
        const path = await this.verify(candidate, signal);
        const version = await this.version(path, launcher, signal);
        if (
          /^2\.\d{1,3}\.\d{1,3}(?:[-+][0-9A-Za-z.-]{1,64})?$/.test(version) &&
          (!requireExpiration || Number(version.split(".")[1]) >= 35)
        )
          return path;
      } catch {
        signal?.throwIfAborted();
      }
    }
    // Callers share installation, but one cancelled waiter cannot cancel another.
    signal?.throwIfAborted();
    if (!this.installing) {
      const controller = new AbortController();
      const job = { controller, waiters: 0, promise: this.install(launcher, controller.signal) };
      job.promise = job.promise.finally(() => {
        if (this.installing === job) this.installing = undefined;
      });
      this.installing = job;
    }
    const installation = this.installing;
    installation.waiters++;
    try {
      if (!signal) return await installation.promise;
      return await new Promise<string>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("1Password setup cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        installation.promise
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    } finally {
      installation.waiters--;
      if (!installation.waiters && this.installing === installation) {
        this.installing = undefined;
        installation.controller.abort();
      }
    }
  }
  private async install(launcher: string, cancelled: AbortSignal): Promise<string> {
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(60_000)]);
    try {
      if ((await lstat(this.managedPath)).isSymbolicLink())
        throw new Error("Managed CLI cannot be a symlink");
      await this.verify(this.managedPath, signal);
      if (
        (await this.version(this.managedPath, launcher, signal)) === MANAGED_ONEPASSWORD_CLI_VERSION
      )
        return this.managedPath;
    } catch {
      signal.throwIfAborted();
    }
    // Every managed directory is private, and symlinks are rejected before writes.
    const root = join(this.options.dataDir, "onepassword-cli");
    for (const directory of [
      this.options.dataDir,
      root,
      dirname(dirname(this.managedPath)),
      dirname(this.managedPath),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
        throw new Error("Invalid managed 1Password CLI directory");
      await chmod(directory, 0o700);
    }
    const archive = await (this.options.download ?? downloadOnePasswordCli)(
      onePasswordArtifact(this.options.arch ?? process.arch),
      signal
    );
    const executable = onePasswordExecutable(archive);
    const staged = join(dirname(this.managedPath), `.op-${randomUUID()}`);
    try {
      const file = await open(staged, "wx", 0o700);
      try {
        await file.writeFile(executable);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.verify(staged, signal);
      if ((await this.version(staged, launcher, signal)) !== MANAGED_ONEPASSWORD_CLI_VERSION)
        throw new Error("The managed 1Password CLI version did not match");
      signal.throwIfAborted();
      await rename(staged, this.managedPath);
      // Atomic publication has committed; finish verifying it even if setup was cancelled.
      await this.verify(this.managedPath, AbortSignal.timeout(15_000));
      return this.managedPath;
    } finally {
      await rm(staged, { force: true });
    }
  }
  readonly command: NativeCommand = async (_file, args, signal) => {
    if (
      !["account list", "vault list", "vault create", "service-account create"].includes(
        args.slice(0, 2).join(" ")
      )
    )
      throw new Error("Unsupported 1Password setup operation");
    const path = await this.resolve(signal, true);
    return this.run(
      await this.launcher(signal),
      [this.options.dataDir, path, ...args],
      this.timeout(signal, args[1] === "list" ? 30_000 : 180_000)
    );
  };
}
