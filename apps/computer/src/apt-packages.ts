/**
 * Keeps the apt packages bots install across a recreated computer (restart, stop/start or update).
 *
 * Only /home/box and the other volumes outlive the container; /usr, /etc and /var start from the
 * image each time. An apt hook (docker/apt-keep-installs.conf) records the packages a bot installed
 * beyond the image's own set, and keeps apt's package lists and downloaded .debs in the home volume.
 * When the computer starts, the entrypoint replays the list: offline from those .debs first, then
 * from the network. The replay runs in the background and never stops the computer from starting.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const APT_STATE_DIR = "/home/box/.openteam/apt";
export const APT_BASELINE_PATH = "/usr/share/openteam/apt-baseline";
/** Cached .debs beyond this are evicted oldest first. */
export const APT_ARCHIVE_CAP_BYTES = 1024 ** 3;

export const aptPaths = (root = APT_STATE_DIR) => ({
  root,
  packages: join(root, "packages"),
  snapshot: join(root, "snapshot.json"),
  archives: join(root, "archives"),
  lists: join(root, "lists"),
  status: join(root, "replay.json"),
  log: join(root, "replay.log"),
});
export type AptPaths = ReturnType<typeof aptPaths>;

export interface PackageSnapshot {
  /** Installed package name to version. */
  installed: Record<string, string>;
  manual: string[];
}

export interface ReplayStatus {
  id: string;
  state: "running" | "done";
  startedAt: string;
  finishedAt?: string;
  restored: string[];
  failed: string[];
}

/** `dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\n'`: a package counts unless it is gone or only its config files are left. */
export function parseInstalled(text: string): Record<string, string> {
  const installed: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const [status, name, version] = line.split("\t");
    if (name && version !== undefined && status?.[1] && !"nc".includes(status[1])) installed[name] = version;
  }
  return installed;
}

/** Names apt marked Auto-Installed in /var/lib/apt/extended_states. */
export function parseAutoInstalled(text: string): Set<string> {
  const auto = new Set<string>();
  for (const stanza of text.split(/\n\s*\n/)) {
    const name = /^Package:\s*(\S+)/m.exec(stanza)?.[1];
    if (name && /^Auto-Installed:\s*1\s*$/m.test(stanza)) auto.add(name);
  }
  return auto;
}

export const packageSnapshot = (installed: Record<string, string>, auto: ReadonlySet<string>): PackageSnapshot => ({
  installed,
  manual: Object.keys(installed).filter((name) => !auto.has(name)).sort(),
});

/**
 * The recorded list after one apt run. Every manual package the image lacks is recorded, so a
 * `dpkg -i` is picked up by the next apt run. Only a package this run took away (manual before,
 * not after) leaves the list: one that failed to replay is not installed before or after, so it stays.
 */
export function nextRecordedList(input: {
  recorded: readonly string[];
  before?: PackageSnapshot;
  after: PackageSnapshot;
  baseline: ReadonlySet<string>;
}): string[] {
  const after = new Set(input.after.manual);
  const removed = new Set((input.before?.manual ?? []).filter((name) => !after.has(name)));
  const next = new Set(input.recorded.filter((name) => !removed.has(name)));
  for (const name of after) if (!input.baseline.has(name)) next.add(name);
  return [...next].sort();
}

export const missingPackages = (recorded: readonly string[], installed: Record<string, string>): string[] =>
  recorded.filter((name) => !(name in installed));

export interface ArchiveEntry { file: string; size: number; mtimeMs: number }

/** apt names its downloads `<name>_<version>_<arch>.deb`. */
const archivePackage = (file: string) => /^([^_]+)_[^_]+_([^_]+)\.deb$/.exec(file);

/**
 * The cached .debs to delete: those of packages this run removed, every version but the newest
 * download of each package, then the oldest until the cache fits the cap.
 */
export function archivesToPrune(entries: readonly ArchiveEntry[], removed: ReadonlySet<string>, capBytes = APT_ARCHIVE_CAP_BYTES): string[] {
  const doomed = new Set<string>();
  const newest = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    const match = archivePackage(entry.file);
    if (!match) continue;
    if (removed.has(match[1]!)) { doomed.add(entry.file); continue; }
    const key = `${match[1]}:${match[2]}`;
    const kept = newest.get(key);
    if (!kept) { newest.set(key, entry); continue; }
    const [older, newer] = kept.mtimeMs <= entry.mtimeMs ? [kept, entry] : [entry, kept];
    doomed.add(older.file);
    newest.set(key, newer);
  }
  const kept = [...newest.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = kept.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of kept) {
    if (total <= capBytes) break;
    doomed.add(entry.file);
    total -= entry.size;
  }
  return [...doomed].sort();
}

export interface CommandResult { code: number | null; output: string }
export type CommandRunner = (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolveResult) => {
    const child = spawn(command, args, {
      env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) => resolveResult({ code: null, output: String(error) }));
    child.once("close", (code) => resolveResult({ code, output: Buffer.concat(chunks).toString("utf8") }));
  });

const readText = (path: string) => readFile(path, "utf8").catch(() => "");
const readLines = async (path: string) => (await readText(path)).split("\n").map((line) => line.trim()).filter(Boolean);

async function writeAtomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

export async function readPackageSnapshot(run: CommandRunner, extendedStates = "/var/lib/apt/extended_states"): Promise<PackageSnapshot> {
  const query = await run("dpkg-query", ["-W", "-f=${db:Status-Abbrev}\\t${Package}\\t${Version}\\n"]);
  if (query.code !== 0) throw new Error(`dpkg-query failed: ${query.output.trim()}`);
  return packageSnapshot(parseInstalled(query.output), parseAutoInstalled(await readText(extendedStates)));
}

export async function readReplayStatus(paths: AptPaths = aptPaths()): Promise<ReplayStatus | null> {
  try {
    const status = JSON.parse(await readFile(paths.status, "utf8")) as ReplayStatus;
    return typeof status?.id === "string" && Array.isArray(status.failed) ? status : null;
  } catch {
    return null;
  }
}

export interface AptOptions {
  paths?: AptPaths;
  baselinePath?: string;
  extendedStates?: string;
  run?: CommandRunner;
}

/** DPkg::Pre-Invoke: remember what was installed before this apt run. */
export async function snapshotBeforeApt(options: AptOptions = {}) {
  const paths = options.paths ?? aptPaths();
  const snapshot = await readPackageSnapshot(options.run ?? runCommand, options.extendedStates);
  await writeAtomic(paths.snapshot, JSON.stringify(snapshot));
}

/** DPkg::Post-Invoke: update the recorded list and trim the .deb cache. */
export async function recordAfterApt(options: AptOptions = {}) {
  const paths = options.paths ?? aptPaths();
  const after = await readPackageSnapshot(options.run ?? runCommand, options.extendedStates);
  const before = await readFile(paths.snapshot, "utf8").then((text) => JSON.parse(text) as PackageSnapshot, () => undefined);
  await rm(paths.snapshot, { force: true });
  const baseline = new Set(await readLines(options.baselinePath ?? APT_BASELINE_PATH));
  const recorded = await readLines(paths.packages);
  const next = nextRecordedList({ recorded, before, after, baseline });
  if (next.join("\n") !== recorded.join("\n")) await writeAtomic(paths.packages, next.length ? `${next.join("\n")}\n` : "");

  const removed = new Set(Object.keys(before?.installed ?? {}).filter((name) => !(name in after.installed)));
  const files = await readdir(paths.archives).catch(() => [] as string[]);
  const entries = (await Promise.all(files.filter((file) => file.endsWith(".deb")).map(async (file) => {
    const info = await stat(join(paths.archives, file)).catch(() => null);
    return info?.isFile() ? { file, size: info.size, mtimeMs: info.mtimeMs } : null;
  }))).filter((entry) => entry !== null);
  for (const file of archivesToPrune(entries, removed)) await rm(join(paths.archives, file), { force: true });
}

const aptInstall = (flags: readonly string[], names: readonly string[]) =>
  ["-y", "-q", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", ...flags, "install", ...names];
const OFFLINE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_TIMEOUT_MS = 3 * 60_000;
const NETWORK_TIMEOUT_MS = 10 * 60_000;

/**
 * Reinstalls recorded packages the computer is missing. apt installs a set all or nothing, so after
 * the offline and network attempts each package still missing gets its own try, and only the
 * ones that can't be installed are reported.
 */
export async function replayRecordedPackages(options: AptOptions & { now?: () => Date; log?: (line: string) => void } = {}): Promise<ReplayStatus> {
  const paths = options.paths ?? aptPaths();
  const run = options.run ?? runCommand;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(line));
  const recorded = await readLines(paths.packages);
  const status: ReplayStatus = { id: crypto.randomUUID(), state: "running", startedAt: now().toISOString(), restored: [], failed: [] };
  const installed = async () => (await readPackageSnapshot(run, options.extendedStates)).installed;
  let missing = missingPackages(recorded, await installed());
  if (!missing.length) {
    await writeAtomic(paths.status, JSON.stringify({ ...status, state: "done", finishedAt: now().toISOString() }));
    return { ...status, state: "done", finishedAt: now().toISOString() };
  }
  await writeAtomic(paths.status, JSON.stringify(status));
  await writeAtomic(paths.log, `${status.startedAt} reinstalling ${missing.join(" ")}\n`);
  const transcript: string[] = [];
  const attempt = async (label: string, args: readonly string[], timeoutMs: number) => {
    const result = await run("apt-get", args, { timeoutMs });
    transcript.push(`$ apt-get ${args.join(" ")}  # ${label}, exit ${result.code ?? "timeout"}\n${result.output}`);
    return result.code === 0;
  };
  const wanted = missing;
  const settle = async () => (missing = missingPackages(wanted, await installed()));

  // Offline first, from the .debs and package lists kept in the home volume.
  if (!(await attempt("offline", aptInstall(["--no-download"], missing), OFFLINE_TIMEOUT_MS)))
    await attempt("offline without recommends", aptInstall(["--no-download", "--no-install-recommends"], missing), OFFLINE_TIMEOUT_MS);
  if ((await settle()).length) {
    await attempt("refresh package lists", ["-q", "update"], UPDATE_TIMEOUT_MS);
    if (!(await attempt("network", aptInstall([], missing), NETWORK_TIMEOUT_MS)) && (await settle()).length > 1)
      for (const name of missing) await attempt(`network, ${name} alone`, aptInstall([], [name]), NETWORK_TIMEOUT_MS);
    await settle();
  }
  status.failed = missing;
  status.restored = wanted.filter((name) => !missing.includes(name));
  status.state = "done";
  status.finishedAt = now().toISOString();
  await writeFile(paths.log, `${transcript.join("\n")}\n${status.finishedAt} restored: ${status.restored.join(" ") || "none"}; failed: ${status.failed.join(" ") || "none"}\n`, { flag: "a" });
  await writeAtomic(paths.status, JSON.stringify(status));
  const seconds = ((Date.parse(status.finishedAt) - Date.parse(status.startedAt)) / 1000).toFixed(1);
  log(`Reinstalled ${status.restored.length} of ${wanted.length} recorded apt packages in ${seconds} s${status.failed.length ? `; could not reinstall ${status.failed.join(", ")} (see ${paths.log})` : ""}`);
  return status;
}
