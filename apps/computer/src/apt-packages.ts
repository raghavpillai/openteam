/**
 * Keeps the apt packages bots install across a recreated computer (restart, stop/start or update).
 *
 * The computer's /usr/local is a volume, but /usr, /etc and /var start from the image each time.
 * apt's and dpkg's hooks (docker/apt-keep-installs.conf, docker/dpkg-keep-installs.cfg) record the
 * packages a bot installed beyond the image's own set, where each came from, the apt sources and
 * keys a bot added, and the .deb files it installed by hand. Package lists and downloads stay in
 * the volume too. When the computer starts, the entrypoint replays the record in the background:
 * offline from the kept .debs first, then from the network. The image's own packages are held
 * meanwhile, so a replay never replaces or removes them, and a package that can't come back is
 * tried again only once the image changes.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const INSTALLS_ROOT = "/usr/local/var/lib/openteam";
/** Cached downloads beyond this are evicted, the earliest downloaded first. Kept local .debs don't count. */
export const APT_ARCHIVE_CAP_BYTES = 1024 ** 3;

export const installsPaths = (root = INSTALLS_ROOT) => ({
  root,
  packages: join(root, "apt", "packages.json"),
  snapshot: join(root, "apt", "snapshot.json"),
  archives: join(root, "apt", "archives"),
  lists: join(root, "apt", "lists"),
  /** The replay refreshes its own copy of the lists, so a bot's `apt-get update` never finds them locked. */
  replayLists: join(root, "apt", "replay-lists"),
  local: join(root, "apt", "local"),
  sources: join(root, "apt", "sources"),
  holds: join(root, "apt", "holds"),
  image: join(root, "image.json"),
  status: join(root, "replay.json"),
  log: join(root, "replay.log"),
});
export type InstallsPaths = ReturnType<typeof installsPaths>;

/** What the image itself ships, written when it was built (docker/computer.Dockerfile). */
export const imageFiles = (root = "/") => ({
  baseline: join(root, "usr/share/openteam/apt-baseline"),
  sourcesBaseline: join(root, "usr/share/openteam/apt-sources-baseline"),
  buildId: join(root, "usr/lib/openteam/build-id"),
});
export type ImageFiles = ReturnType<typeof imageFiles>;

/** Where bots add apt sources, keys and pins; files the image or a package owns are not theirs. */
export const APT_SOURCE_LOCATIONS = [
  "/etc/apt/sources.list",
  "/etc/apt/sources.list.d",
  "/etc/apt/keyrings",
  "/etc/apt/trusted.gpg",
  "/etc/apt/trusted.gpg.d",
  "/etc/apt/preferences.d",
  "/usr/share/keyrings",
];

export interface PackageSnapshot {
  /** Installed package name to version. */
  installed: Record<string, string>;
  manual: string[];
}

export interface RecordedPackage {
  /** The installed version when it was recorded. */
  version?: string;
  /** The apt source it came from, as "<URI> <suite>", when that isn't one of the image's own. */
  origin?: string;
  /** A kept .deb under local/, for a package installed from a file. */
  deb?: string;
  /** Installed from a .deb file that was not kept, so it can't come back. */
  local?: boolean;
  /** Why the last start on this image build couldn't reinstall it; it is tried again on a new build. */
  failed?: { build: string; reason: string };
}
export type PackageRecord = Record<string, RecordedPackage>;

export interface ReplayStatus {
  id: string;
  state: "running" | "done";
  startedAt: string;
  finishedAt?: string;
  restored: string[];
  /** Packages that can't come back on this image; a bot hears about each once. */
  failed: Array<{ name: string; reason: string }>;
  /** Packages the network or their source kept from coming back; the next start tries again. */
  pending: string[];
  languages?: import("./language-packages").LanguageRebuild;
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
 * The recorded names after one apt or dpkg run. Every manual package the image lacks is recorded.
 * Only a package this run took away (manual before, not after) leaves the list: one that failed
 * to replay is not installed before or after, so it stays until the bot forgets it.
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

export interface PolicySource { uri: string; suite: string }
export interface PackagePolicy {
  installed?: string;
  candidate?: string;
  /** Newest first, as apt lists them; a source-less version is only in dpkg's status. */
  versions: Array<{ version: string; sources: PolicySource[] }>;
}

/** `apt-cache policy NAME...`. */
export function parsePolicy(text: string): Record<string, PackagePolicy> {
  const policies: Record<string, PackagePolicy> = {};
  let current: PackagePolicy | undefined;
  let version: PackagePolicy["versions"][number] | undefined;
  for (const line of text.split("\n")) {
    const name = /^(\S+):$/.exec(line)?.[1];
    if (name) { policies[name] = current = { versions: [] }; version = undefined; continue; }
    if (!current) continue;
    const field = /^\s+(Installed|Candidate):\s*(\S+)/.exec(line);
    if (field) { const value = field[2] === "(none)" ? undefined : field[2]; if (field[1] === "Installed") current.installed = value; else current.candidate = value; continue; }
    const entry = /^ (?:\*\*\*| {3}) (\S+) -?\d+/.exec(line);
    if (entry) { current.versions.push(version = { version: entry[1]!, sources: [] }); continue; }
    const source = /^\s{6,}-?\d+ (\S+:\/\/\S+|file:\S+) (\S+?)(?:\/\S+)? \S+ Packages$/.exec(line);
    if (source && version) version.sources.push({ uri: source[1]!.replace(/\/+$/, ""), suite: source[2]! });
  }
  return policies;
}

const originKey = (source: PolicySource) => `${source.uri} ${source.suite}`;

/** "uri suite" pairs from deb822 .sources and one-line .list files. */
export function parseSourceFile(text: string): string[] {
  const pairs: string[] = [];
  if (/^\s*Types:/m.test(text)) {
    for (const stanza of text.split(/\n\s*\n/)) {
      if (/^Enabled:\s*no\s*$/im.test(stanza)) continue;
      const uris = /^URIs:(.*)$/m.exec(stanza)?.[1]?.trim().split(/\s+/) ?? [];
      const suites = /^Suites:(.*)$/m.exec(stanza)?.[1]?.trim().split(/\s+/) ?? [];
      for (const uri of uris) for (const suite of suites) pairs.push(`${uri.replace(/\/+$/, "")} ${suite}`);
    }
  } else {
    for (const line of text.split("\n")) {
      const match = /^\s*deb\s+(?:\[[^\]]*\]\s+)?(\S+)\s+(\S+)/.exec(line);
      if (match) pairs.push(`${match[1]!.replace(/\/+$/, "")} ${match[2]}`);
    }
  }
  return pairs;
}

/** Where the installed version came from: one of the image's sources, a bot's source, or a file. */
export function classifyOrigin(policy: PackagePolicy | undefined, imageSources: ReadonlySet<string>): Pick<RecordedPackage, "origin" | "local"> {
  const sources = policy?.versions.find((entry) => entry.version === policy.installed)?.sources ?? [];
  if (!sources.length) return { local: true };
  if (sources.some((source) => imageSources.has(originKey(source)))) return {};
  return { origin: originKey(sources[0]!) };
}

/** What to ask apt for: the newest version the package's own source has, or any candidate for the image's sources. */
export function installTarget(name: string, entry: RecordedPackage, policy: PackagePolicy | undefined): string | undefined {
  if (!entry.origin) return policy?.candidate ? name : undefined;
  const version = policy?.versions.find((candidate) => candidate.sources.some((source) => originKey(source) === entry.origin))?.version;
  return version ? `${name}=${version}` : undefined;
}

export interface ArchiveEntry { file: string; size: number; downloadedMs: number }

/** apt names its downloads `<name>_<version>_<arch>.deb`. */
const archivePackage = (file: string) => /^([^_]+)_([^_]+)_([^_]+)\.deb$/.exec(file);
/** apt writes ':' in a version as %3a in the file name. */
export const debFileName = (name: string, version: string, arch: string) => `${name}_${version.replace(/:/g, "%3a")}_${arch}.deb`;

/**
 * The cached downloads to delete: those of packages this run removed, every version but the newest
 * download of each package, then the earliest downloaded until the cache fits the cap. apt dates a
 * download with the server's time, so its change time is the download time.
 */
export function archivesToPrune(entries: readonly ArchiveEntry[], removed: ReadonlySet<string>, capBytes = APT_ARCHIVE_CAP_BYTES): string[] {
  const doomed = new Set<string>();
  const newest = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    const match = archivePackage(entry.file);
    if (!match) continue;
    if (removed.has(match[1]!)) { doomed.add(entry.file); continue; }
    const key = `${match[1]}:${match[3]}`;
    const kept = newest.get(key);
    if (!kept) { newest.set(key, entry); continue; }
    const [older, newer] = kept.downloadedMs <= entry.downloadedMs ? [kept, entry] : [entry, kept];
    doomed.add(older.file);
    newest.set(key, newer);
  }
  const kept = [...newest.values()].sort((a, b) => a.downloadedMs - b.downloadedMs);
  let total = kept.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of kept) {
    if (total <= capBytes) break;
    doomed.add(entry.file);
    total -= entry.size;
  }
  return [...doomed].sort();
}

export interface CommandResult { code: number | null; output: string }
export type CommandRunner = (command: string, args: readonly string[], options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

/** Package tools run with a fixed environment: no bot-writable search paths, no supervisor secrets. */
export const PACKAGE_TOOL_ENVIRONMENT = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
  DEBIAN_FRONTEND: "noninteractive",
};

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolveResult) => {
    const child = spawn(command, args, {
      env: options.env ?? PACKAGE_TOOL_ENVIRONMENT,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout stops dpkg along with apt-get.
      detached: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    const signalGroup = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; signalGroup("SIGTERM"); setTimeout(() => signalGroup("SIGKILL"), 10_000).unref(); }, options.timeoutMs)
      : undefined;
    child.once("error", (error) => { clearTimeout(timer); resolveResult({ code: null, output: String(error) }); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code: timedOut ? null : code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });

const readText = (path: string) => readFile(path, "utf8").catch(() => "");
const readLines = async (path: string) => (await readText(path)).split("\n").map((line) => line.trim()).filter(Boolean);

export async function writeAtomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o644 });
  await rename(temporary, path);
}

export async function readRecord(paths: InstallsPaths): Promise<PackageRecord> {
  try {
    const saved = JSON.parse(await readFile(paths.packages, "utf8")) as { packages?: PackageRecord };
    return saved?.packages && typeof saved.packages === "object" ? saved.packages : {};
  } catch {
    return {};
  }
}

/** Re-reads the record just before writing, so a hook and the replay don't undo each other's changes. */
export async function updateRecord(paths: InstallsPaths, change: (record: PackageRecord) => void): Promise<PackageRecord> {
  const record = await readRecord(paths);
  const before = JSON.stringify(record);
  change(record);
  const sorted = Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  if (JSON.stringify(sorted) !== before) await writeAtomic(paths.packages, `${JSON.stringify({ packages: sorted }, null, 2)}\n`);
  return sorted;
}

export async function readPackageSnapshot(run: CommandRunner, extendedStates = "/var/lib/apt/extended_states"): Promise<PackageSnapshot> {
  const query = await run("dpkg-query", ["-W", "-f=${db:Status-Abbrev}\\t${Package}\\t${Version}\\n"]);
  if (query.code !== 0) throw new Error(`dpkg-query failed: ${query.output.trim()}`);
  return packageSnapshot(parseInstalled(query.output), parseAutoInstalled(await readText(extendedStates)));
}

export async function readReplayStatus(paths: InstallsPaths = installsPaths()): Promise<ReplayStatus | null> {
  try {
    const status = JSON.parse(await readFile(paths.status, "utf8")) as ReplayStatus;
    return typeof status?.id === "string" && Array.isArray(status.failed) ? status : null;
  } catch {
    return null;
  }
}

export interface AptOptions {
  paths?: InstallsPaths;
  image?: ImageFiles;
  extendedStates?: string;
  run?: CommandRunner;
  /** Where to look for bot-added apt sources; tests point this at a scratch tree. */
  sourceLocations?: readonly string[];
  /** Maps an absolute system path to where it is on disk; tests root it in a scratch tree. */
  systemPath?: (path: string) => string;
}

const optionsWithDefaults = (options: AptOptions) => ({
  paths: options.paths ?? installsPaths(),
  image: options.image ?? imageFiles(),
  run: options.run ?? runCommand,
  sourceLocations: options.sourceLocations ?? APT_SOURCE_LOCATIONS,
  systemPath: options.systemPath ?? ((path: string) => path),
  extendedStates: options.extendedStates,
});

async function policies(run: CommandRunner, names: readonly string[], extra: readonly string[] = []): Promise<Record<string, PackagePolicy>> {
  if (!names.length) return {};
  return parsePolicy((await run("apt-cache", [...extra, "policy", ...names])).output);
}

/** The "uri suite" pairs of the image's own apt sources. */
export async function imageSources(image: ImageFiles, systemPath: (path: string) => string = (path) => path): Promise<Set<string>> {
  const files = (await readLines(image.sourcesBaseline)).filter((file) => /\/sources\.list(\.d\/.+\.(list|sources))?$/.test(file));
  return new Set((await Promise.all(files.map(async (file) => parseSourceFile(await readText(systemPath(file)))))).flat());
}

/** Files under the source locations, by absolute system path. */
async function sourceFiles(locations: readonly string[], systemPath: (path: string) => string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (path: string): Promise<void> => {
    const info = await stat(systemPath(path)).catch(() => null);
    if (info?.isFile()) found.push(path);
    else if (info?.isDirectory()) for (const entry of await readdir(systemPath(path))) await walk(join(path, entry));
  };
  for (const location of locations) await walk(location);
  return found.sort();
}

/** Keeps a copy of each apt source, key and pin a bot added, so the replay can put them back first. */
export async function captureSources(options: AptOptions & { removeGone?: boolean } = {}) {
  const { paths, image, run, sourceLocations, systemPath } = optionsWithDefaults(options);
  const baseline = new Set(await readLines(image.sourcesBaseline));
  const candidates = (await sourceFiles(sourceLocations, systemPath)).filter((file) => !baseline.has(file));
  // Files a package installed (keyring packages, for one) come back with that package.
  const owned = candidates.length ? new Set(
    (await run("dpkg-query", ["-S", ...candidates])).output.split("\n").flatMap((line) => /^[^:]+(?::[^:]+)?: (\/.+)$/.exec(line)?.[1] ?? [])
  ) : new Set<string>();
  const bots = candidates.filter((file) => !owned.has(file));
  for (const file of bots) {
    const kept = join(paths.sources, file);
    const [text, saved] = await Promise.all([readFile(systemPath(file)), readFile(kept).catch(() => null)]);
    if (!saved?.equals(text)) { await mkdir(dirname(kept), { recursive: true }); await writeFile(kept, text, { mode: 0o644 }); }
  }
  if (!options.removeGone) return;
  const wanted = new Set(bots);
  for (const file of await sourceFiles(["/"], (path) => join(paths.sources, path))) if (!wanted.has(file)) await rm(join(paths.sources, file), { force: true });
}

/** Puts back the kept sources the image lacks. A file that already exists stays as it is. */
export async function restoreSources(options: AptOptions = {}): Promise<string[]> {
  const { paths, systemPath } = optionsWithDefaults(options);
  const restored: string[] = [];
  for (const file of await sourceFiles(["/"], (path) => join(paths.sources, path))) {
    const target = systemPath(file);
    if (await stat(target).catch(() => null)) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(paths.sources, file), target);
    restored.push(file);
  }
  return restored;
}

const dpkgPid = async (hookPid: number) => {
  // dpkg runs a hook through `sh -c`, so dpkg is the shell's parent.
  const status = await readText(`/proc/${hookPid}/status`);
  return Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? 0);
};

/** The .deb files a dpkg command line names that aren't in apt's cache (`dpkg -i ./x.deb`). */
export function localDebArguments(argv: readonly string[], cwd: string, archives: string): string[] {
  return argv.slice(1).filter((arg) => arg.endsWith(".deb") && !arg.startsWith("-"))
    .map((arg) => (isAbsolute(arg) ? arg : resolve(cwd, arg)))
    .filter((path) => dirname(path) !== archives);
}

/** dpkg's pre-invoke hook: keep the local .debs this dpkg run installs, and snapshot a plain dpkg run. */
export async function beforeDpkg(options: AptOptions & { hookPid?: number; underApt?: boolean } = {}) {
  const { paths, run } = optionsWithDefaults(options);
  const pid = await dpkgPid(options.hookPid ?? process.ppid);
  const argv = (await readText(`/proc/${pid}/cmdline`)).split("\0").filter(Boolean);
  for (const deb of localDebArguments(argv, process.cwd(), paths.archives)) await keepLocalDeb(run, paths, deb);
  if (!(options.underApt ?? Boolean(process.env.DPKG_FRONTEND_LOCKED))) await snapshotBeforeApt(options);
}

async function keepLocalDeb(run: CommandRunner, paths: InstallsPaths, deb: string) {
  const fields = await run("dpkg-deb", ["-f", deb, "Package", "Version", "Architecture"]);
  const value = (field: string) => new RegExp(`^${field}: (\\S+)`, "m").exec(fields.output)?.[1];
  const [name, version, arch] = [value("Package"), value("Version"), value("Architecture")];
  if (fields.code !== 0 || !name || !version || !arch) return;
  await mkdir(paths.local, { recursive: true });
  await copyFile(deb, join(paths.local, debFileName(name, version, arch)));
}

/** apt's DPkg::Pre-Invoke (and dpkg's for a plain dpkg run): remember what was installed before. */
export async function snapshotBeforeApt(options: AptOptions = {}) {
  const { paths, run, extendedStates } = optionsWithDefaults(options);
  await writeAtomic(paths.snapshot, JSON.stringify(await readPackageSnapshot(run, extendedStates)));
}

/** apt's DPkg::Post-Invoke and dpkg's post-invoke: update the record, its sources and .debs, and trim the cache. */
export async function recordAfterApt(options: AptOptions = {}) {
  const { paths, image, run, extendedStates, systemPath } = optionsWithDefaults(options);
  const after = await readPackageSnapshot(run, extendedStates);
  const before = await readFile(paths.snapshot, "utf8").then((text) => JSON.parse(text) as PackageSnapshot, () => undefined);
  await rm(paths.snapshot, { force: true });
  const baseline = new Set(await readLines(image.baseline));
  const recorded = await readRecord(paths);
  const names = nextRecordedList({ recorded: Object.keys(recorded), before, after, baseline });
  // Where each newly installed (or newly upgraded) version came from.
  const changed = names.filter((name) => after.installed[name] !== undefined && after.installed[name] !== recorded[name]?.version);
  const policy = await policies(run, changed);
  const ownSources = await imageSources(image, systemPath);
  const localFiles = new Set(await readdir(paths.local).catch(() => [] as string[]));
  const archiveFiles = new Set(await readdir(paths.archives).catch(() => [] as string[]));
  const classified: PackageRecord = {};
  for (const name of changed) {
    const version = after.installed[name]!;
    const origin = classifyOrigin(policy[name], ownSources);
    if (!origin.local) { classified[name] = { version, ...origin }; continue; }
    // `apt install ./x.deb` passes the file through apt's cache; `dpkg -i` was kept by the pre-invoke hook.
    const wanted = new RegExp(`^${name.replace(/[.+]/g, "\\$&")}_${version.replace(/:/g, "%3a").replace(/[.+]/g, "\\$&")}_[^_]+\\.deb$`);
    let deb = [...localFiles].find((file) => wanted.test(file));
    const cached = deb ? undefined : [...archiveFiles].find((file) => wanted.test(file));
    if (cached) {
      await mkdir(paths.local, { recursive: true });
      await copyFile(join(paths.archives, cached), join(paths.local, cached));
      deb = cached;
    }
    classified[name] = deb ? { version, deb } : { version, local: true };
  }
  const next = await updateRecord(paths, (record) => {
    for (const name of Object.keys(record)) if (!names.includes(name)) delete record[name];
    for (const name of names) record[name] = classified[name] ?? record[name] ?? {};
  });

  const status = await readReplayStatus(paths);
  // Until this start's replay has put the kept sources back, a missing one isn't the bot's removal.
  await captureSources({ ...options, removeGone: status?.state !== "running" }).catch((error) => console.error(`openteam installs: keeping apt sources failed: ${error}`));

  const keptDebs = new Set(Object.values(next).flatMap((entry) => (entry.deb ? [entry.deb] : [])));
  for (const file of await readdir(paths.local).catch(() => [] as string[])) if (!keptDebs.has(file)) await rm(join(paths.local, file), { force: true });
  const removed = new Set(Object.keys(before?.installed ?? {}).filter((name) => !(name in after.installed)));
  const files = await readdir(paths.archives).catch(() => [] as string[]);
  const entries = (await Promise.all(files.filter((file) => file.endsWith(".deb")).map(async (file) => {
    const info = await stat(join(paths.archives, file)).catch(() => null);
    return info?.isFile() ? { file, size: info.size, downloadedMs: info.ctimeMs } : null;
  }))).filter((entry) => entry !== null);
  for (const file of archivesToPrune(entries, removed)) await rm(join(paths.archives, file), { force: true });
}

/** Stops reinstalling these packages: the bot's way out for one that can't come back. */
export async function forgetPackages(names: readonly string[], options: AptOptions = {}): Promise<{ forgotten: string[]; unknown: string[] }> {
  const { paths } = optionsWithDefaults(options);
  const forgotten: string[] = [];
  const unknown: string[] = [];
  const record = await updateRecord(paths, (record) => {
    for (const name of names) {
      if (!record[name]) { unknown.push(name); continue; }
      delete record[name];
      forgotten.push(name);
    }
  });
  const keptDebs = new Set(Object.values(record).flatMap((entry) => (entry.deb ? [entry.deb] : [])));
  for (const file of await readdir(paths.local).catch(() => [] as string[])) if (!keptDebs.has(file)) await rm(join(paths.local, file), { force: true });
  return { forgotten, unknown };
}

const aptInstall = (flags: readonly string[], targets: readonly string[]) =>
  ["-y", "-q", "--no-remove", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", ...flags, "install", ...targets];
const OFFLINE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_TIMEOUT_MS = 3 * 60_000;
const NETWORK_TIMEOUT_MS = 15 * 60_000;
const SIMULATE_TIMEOUT_MS = 60_000;

/** The first apt error, said the way a bot can act on. */
export function installFailureReason(output: string): string {
  if (/held broken packages|Held packages were changed/i.test(output))
    return "it needs versions of packages the computer's image provides that differ from the image's";
  const error = output.split("\n").map((line) => line.trim()).find((line) => line.startsWith("E: ") || line.startsWith("dpkg: error"));
  return error ? `apt failed: ${error.replace(/^E: /, "").slice(0, 200)}` : "apt could not install it";
}

const UNREACHABLE = /Temporary failure resolving|Could not resolve|Failed to fetch|Unable to connect|Connection timed out|Network is unreachable|Could not connect/i;
const unreachable = (output: string) => UNREACHABLE.test(output);

/** The URLs `apt-get update` could not fetch. */
export function unfetchedUrls(output: string): string[] {
  return output.split("\n").flatMap((line) => /^(?:Err:\d+|W: Failed to fetch|E: Failed to fetch) (\S+)/.exec(line.trim())?.[1] ?? []);
}

export interface ReplayOptions extends AptOptions {
  now?: () => Date;
  log?: (line: string) => void;
  /** Runs after the apt replay, while the status still says running (the language step). */
  afterApt?: (status: ReplayStatus) => Promise<void>;
}

/**
 * Reinstalls the recorded packages the computer is missing. First it finishes an interrupted dpkg
 * run and puts back the bots' apt sources, then holds the image's packages. Each pass resolves
 * what apt can install (a package from a bot's source only at a version that source has) and
 * installs it in one run; a package that breaks the run is found with a dry run and set aside, so
 * it doesn't hold up the rest. Passes go offline, then online with fresh lists, then online once
 * more after the first pass installed what a source may need (certificates, transports).
 */
export async function replayRecordedPackages(options: ReplayOptions = {}): Promise<ReplayStatus> {
  const { paths, image, run, extendedStates, systemPath } = optionsWithDefaults(options);
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(line));
  const build = (await readText(image.buildId)).trim() || "unknown";
  const status: ReplayStatus = { id: crypto.randomUUID(), state: "running", startedAt: now().toISOString(), restored: [], failed: [], pending: [] };
  await writeAtomic(paths.status, JSON.stringify(status));
  const transcript: string[] = [];
  const attempt = async (label: string, command: string, args: readonly string[], timeoutMs: number) => {
    const result = await run(command, args, { timeoutMs });
    transcript.push(`$ ${command} ${args.join(" ")}  # ${label}, exit ${result.code ?? "timeout"}\n${result.output}`);
    return result;
  };
  const installed = async () => (await readPackageSnapshot(run, extendedStates)).installed;

  // A computer killed mid-install leaves dpkg half done, and every later apt run fails until this runs.
  await attempt("finish an interrupted dpkg run", "dpkg", ["--configure", "-a"], OFFLINE_TIMEOUT_MS);
  await releaseHolds(paths, run);
  const restoredSources = await restoreSources(options);
  if (restoredSources.length) transcript.push(`restored apt sources: ${restoredSources.join(" ")}`);

  const record = await readRecord(paths);
  const present = await installed();
  // A package that already failed on this image build stays quiet until the image changes.
  const missing = Object.keys(record).filter((name) => !(name in present) && record[name]!.failed?.build !== build);
  const failed = new Map<string, string>();
  for (const name of missing) if (record[name]!.local && !record[name]!.deb) failed.set(name, "it was installed from a .deb file that was not kept");
  let todo = missing.filter((name) => !failed.has(name));
  const pending: string[] = [];
  if (todo.length) {
    await writeFile(paths.log, `${status.startedAt} reinstalling ${todo.join(" ")}\n`);
    await holdImagePackages(paths, image, run);
    try {
      const pass = async (label: string, lists: readonly string[], download: boolean) => {
        const policy = await policies(run, todo.filter((name) => !record[name]!.deb), lists);
        const targets = new Map<string, string>();
        for (const name of todo) {
          const entry = record[name]!;
          const target = entry.deb ? join(paths.local, entry.deb) : installTarget(name, entry, policy[name]);
          if (!target) continue;
          if (entry.deb && !(await stat(target).catch(() => null))) { failed.set(name, "its kept .deb file is gone"); continue; }
          targets.set(name, target);
        }
        if (!targets.size) return;
        // Offline, apt installs what its cache has and holds back the rest.
        const flags = [...lists, ...(download ? [] : ["--no-download", "--ignore-missing"])];
        const timeout = download ? NETWORK_TIMEOUT_MS : OFFLINE_TIMEOUT_MS;
        let result = await attempt(label, "apt-get", aptInstall(flags, [...targets.values()]), timeout);
        // Offline, a missing download is expected; online, a network error is for the next start.
        if (result.code === 0 || !download || unreachable(result.output)) return;
        // Find the packages that break the run with dry runs, and install the rest together.
        for (const [name, target] of targets) {
          const dryRun = await attempt(`${label}, dry run for ${name}`, "apt-get", ["-s", ...aptInstall(lists, [target])], SIMULATE_TIMEOUT_MS);
          if (dryRun.code !== 0) { failed.set(name, installFailureReason(dryRun.output)); targets.delete(name); }
        }
        if (!targets.size) return;
        result = await attempt(`${label}, without the failing ones`, "apt-get", aptInstall(flags, [...targets.values()]), timeout);
        if (result.code === 0 || unreachable(result.output)) return;
        // Only a failure dry runs can't see (a maintainer script, say) gets here.
        for (const [name, target] of targets) {
          const alone = targets.size === 1 ? result : await attempt(`${label}, ${name} alone`, "apt-get", aptInstall(flags, [target]), timeout);
          if (alone.code !== 0 && !unreachable(alone.output)) failed.set(name, installFailureReason(alone.output));
        }
      };
      const settle = async () => { const now = await installed(); todo = todo.filter((name) => !(name in now) && !failed.has(name)); };

      // Offline, from the .debs and lists kept in the volume.
      await pass("offline", [], false);
      await settle();
      if (todo.length) {
        // The replay refreshes its own copy of the lists: apt can't wait for the lists lock, so a
        // bot's `apt-get update` would fail while the replay held the shared one.
        const lists = ["-o", `Dir::State::Lists=${paths.replayLists}`, "-o", "Dir::Cache::pkgcache=", "-o", "Dir::Cache::srcpkgcache="];
        await rm(paths.replayLists, { recursive: true, force: true });
        await mkdir(join(paths.replayLists, "partial"), { recursive: true });
        await run("cp", ["-a", `${paths.lists}/.`, paths.replayLists]);
        await rm(join(paths.replayLists, "lock"), { force: true });
        let refresh = await attempt("refresh package lists", "apt-get", [...lists, "-q", "update"], UPDATE_TIMEOUT_MS);
        const before = todo.length;
        await pass("network", lists, true);
        await settle();
        // A bot's source may have needed something the first pass installed; refresh and try again.
        if (todo.length && (todo.length < before || unfetchedUrls(refresh.output).length)) {
          refresh = await attempt("refresh package lists again", "apt-get", [...lists, "-q", "update"], UPDATE_TIMEOUT_MS);
          await pass("network, second pass", lists, true);
          await settle();
        }
        // Without the image's own sources the network is down: everything left waits for the next start.
        const own = [...(await imageSources(image, systemPath))].map((pair) => pair.split(" ")[0]!);
        const unfetched = unfetchedUrls(refresh.output);
        const online = refresh.code === 0 && !unfetched.some((url) => own.some((uri) => url.startsWith(uri)));
        for (const name of todo) {
          const origin = record[name]!.origin;
          if (!online) pending.push(name);
          else if (!origin) failed.set(name, "no apt source the computer has offers it any more");
          else if (unfetched.some((url) => url.startsWith(origin.split(" ")[0]!))) failed.set(name, `its apt source (${origin}) could not be reached`);
          else failed.set(name, `its apt source (${origin}) no longer offers it`);
        }
      }
    } finally {
      await releaseHolds(paths, run);
    }
  }
  const after = await installed();
  status.restored = missing.filter((name) => name in after);
  status.failed = [...failed].filter(([name]) => !(name in after)).map(([name, reason]) => ({ name, reason }));
  status.pending = pending.filter((name) => !(name in after));
  await updateRecord(paths, (current) => {
    for (const name of status.restored) if (current[name]) delete current[name]!.failed;
    for (const { name, reason } of status.failed) if (current[name]) current[name]!.failed = { build, reason };
  });
  if (missing.length) {
    const summary = `restored: ${status.restored.join(" ") || "none"}; failed: ${status.failed.map(({ name, reason }) => `${name} (${reason})`).join(", ") || "none"}; tried again next start: ${status.pending.join(" ") || "none"}`;
    await writeFile(paths.log, `${transcript.join("\n")}\n${now().toISOString()} ${summary}\n`, { flag: "a" });
    const seconds = ((now().getTime() - Date.parse(status.startedAt)) / 1000).toFixed(1);
    log(`Reinstalled ${status.restored.length} of ${missing.length} recorded apt packages in ${seconds} s; ${summary} (see ${paths.log})`);
  }
  await options.afterApt?.(status).catch((error) => log(`openteam installs: ${error instanceof Error ? error.message : String(error)}`));
  status.state = "done";
  status.finishedAt = now().toISOString();
  await writeAtomic(paths.status, JSON.stringify(status));
  return status;
}

/** Holds the image's packages for the replay; the names held are kept so a killed replay's holds are released next time. */
async function holdImagePackages(paths: InstallsPaths, image: ImageFiles, run: CommandRunner) {
  const selections = await run("dpkg", ["--get-selections"]);
  const held = new Set(selections.output.split("\n").flatMap((line) => (/^(\S+)\s+hold$/.exec(line)?.[1] ?? [])).map((name) => name.replace(/:.*$/, "")));
  const installed = new Set(selections.output.split("\n").flatMap((line) => (/^(\S+)\s+install$/.exec(line)?.[1] ?? [])).map((name) => name.replace(/:.*$/, "")));
  const hold = (await readLines(image.baseline)).filter((name) => installed.has(name) && !held.has(name));
  if (!hold.length) return;
  await writeAtomic(paths.holds, `${hold.join("\n")}\n`);
  await setSelections(run, hold, "hold");
}

async function releaseHolds(paths: InstallsPaths, run: CommandRunner) {
  const held = await readLines(paths.holds);
  if (held.length) await setSelections(run, held, "install");
  await rm(paths.holds, { force: true });
}

async function setSelections(run: CommandRunner, names: readonly string[], state: "hold" | "install") {
  // dpkg --set-selections reads stdin; a here-string through sh keeps the runner simple.
  const list = names.map((name) => `${name} ${state}`).join("\n");
  await run("sh", ["-c", 'printf "%s\\n" "$1" | dpkg --set-selections', "openteam-holds", list]);
}

export const describeEntry = (name: string, entry: RecordedPackage, installed: boolean) =>
  `${name.padEnd(28)} ${installed ? "installed" : entry.failed ? `missing: ${entry.failed.reason} (tried again when the computer's image changes)` : entry.local && !entry.deb ? "missing: it was installed from a .deb file that was not kept" : "missing (reinstalled at the next start)"}${entry.origin ? `, from ${entry.origin}` : entry.deb ? ", from a kept .deb file" : ""}`;

