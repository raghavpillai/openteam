import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

interface ManifestTombstone {
  path: string;
  deletedAt: string;
}

export interface BoxStoreManifest {
  version: 1;
  revision: number;
  generatedAt: string;
  files: ManifestFile[];
  tombstones?: ManifestTombstone[];
  etag: string;
}

interface SnapshotSignatureCache {
  version: 1;
  manifestEtag: string;
  signatures: Record<string, string>;
}

export interface BoxStoreDirtyHint {
  all?: boolean;
  sand?: boolean;
  agentIds?: readonly string[];
  sandPaths?: readonly string[];
  workspace?: boolean;
  pi?: boolean;
  chrome?: boolean;
}

export interface BoxStoreSyncMetrics {
  scheduledRequests: number;
  coalescedRequests: number;
  snapshotRuns: number;
  directoriesVisited: number;
  sourceFilesInspected: number;
  sourceFilesRead: number;
  sourceBytesRead: number;
  contentHashes: number;
  signatureReuses: number;
  sqliteVacuums: number;
  repairRoots: number;
  repairDirectoriesVisited: number;
  repairEntriesInspected: number;
}

const digest = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const sqliteName = (name: string): boolean =>
  name === "store.db" || name === "conversation-blobs.db";

const sqliteSidecar = (name: string): boolean =>
  /^(?:store|conversation-blobs)\.db-(?:shm|wal)$/.test(name);

const temporaryName = (name: string): boolean =>
  name.startsWith(".box-store-part-") || name.startsWith(".box-store-snap-");

const sqliteRecoveryArtifact = (name: string): boolean =>
  /^(?:store|conversation-blobs)\.db(?:\.corrupt-.*|\.pending|.*\.(?:intent|pending|replacement))$/.test(
    name
  );

const EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  "Cache",
  "Code Cache",
  "GPUCache",
]);

const logicalContains = (parent: string, candidate: string): boolean =>
  candidate === parent || candidate.startsWith(`${parent}/`);

const collapseLogicalPrefixes = (prefixes: Iterable<string>): string[] => {
  const sorted = [...new Set(prefixes)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right)
  );
  const collapsed: string[] = [];
  for (const prefix of sorted) {
    if (!collapsed.some((parent) => logicalContains(parent, prefix))) collapsed.push(prefix);
  }
  return collapsed;
};

const COPY_IN_CRITICAL_BASENAMES = new Set([
  "store.db",
  "conversation-blobs.db",
  "Cookies",
  "Login Data",
  "Web Data",
  "source-map.json",
]);

const atomicWrite = async (path: string, bytes: Uint8Array, mode = 0o600): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.box-store-part-${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const manifestEtag = (manifest: Omit<BoxStoreManifest, "etag">): string =>
  digest(
    JSON.stringify({
      version: manifest.version,
      revision: manifest.revision,
      generatedAt: manifest.generatedAt,
      files: manifest.files,
      ...(manifest.tombstones ? { tombstones: manifest.tombstones } : {}),
    })
  );

export class BoxStoreSync {
  private readonly storeRoot: string;
  private readonly manifestPath: string;
  private readonly signatureCachePath: string;
  private readonly blobsRoot: string;
  private readonly home: string;
  private readonly sandRoot: string;
  private readonly workspaceRoot: string;
  private readonly hasLiveAgentHandle: (agentId: string) => boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private scheduledRun: Promise<void> | null = null;
  private scheduledRerun = false;
  private pendingFullSnapshot = false;
  private readonly pendingDirtyPrefixes = new Set<string>();
  private pendingChromeSnapshot = false;
  private readonly metrics: BoxStoreSyncMetrics = {
    scheduledRequests: 0,
    coalescedRequests: 0,
    snapshotRuns: 0,
    directoriesVisited: 0,
    sourceFilesInspected: 0,
    sourceFilesRead: 0,
    sourceBytesRead: 0,
    contentHashes: 0,
    signatureReuses: 0,
    sqliteVacuums: 0,
    repairRoots: 0,
    repairDirectoriesVisited: 0,
    repairEntriesInspected: 0,
  };

  constructor(
    options: {
      storeRoot?: string;
      home?: string;
      sandRoot?: string;
      workspaceRoot?: string;
      hasLiveAgentHandle?: (agentId: string) => boolean;
    } = {}
  ) {
    this.storeRoot = resolve(
      options.storeRoot ?? process.env.OPENBOT_BOX_STORE_ROOT ?? "/box-store"
    );
    this.manifestPath = join(this.storeRoot, "manifest.json");
    this.signatureCachePath = join(this.storeRoot, ".snapshot-signatures.json");
    this.blobsRoot = join(this.storeRoot, "blobs");
    this.home = resolve(options.home ?? process.env.HOME ?? "/home/box");
    this.sandRoot = resolve(
      options.sandRoot ?? process.env.OPENBOT_AGENT_DATA_CANONICAL_ROOT ?? "/home/box/sand-data"
    );
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? process.env.OPENBOT_WORKSPACE_ROOT ?? "/workspace"
    );
    this.hasLiveAgentHandle = options.hasLiveAgentHandle ?? (() => false);
  }

  async start(): Promise<void> {
    await mkdir(this.blobsRoot, { recursive: true, mode: 0o700 });
    await this.repairTemporaryFiles();
    if (process.env.OPENBOT_BOX_COPY_IN === "1") await this.copyIn();
    this.periodic = setInterval(() => this.scheduleSnapshot(0, { all: true }), 120_000);
    this.periodic.unref?.();
  }

  scheduleSnapshot(delayMs = 5_000, hint: BoxStoreDirtyHint = { all: true }): void {
    this.metrics.scheduledRequests += 1;
    this.mergeDirtyHint(hint);
    if (this.scheduledRun) {
      this.scheduledRerun = true;
      this.metrics.coalescedRequests += 1;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.metrics.coalescedRequests += 1;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startScheduledRun();
    }, delayMs);
    this.timer.unref?.();
  }

  async flushScheduledSnapshots(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.startScheduledRun();
    }
    while (this.scheduledRun) await this.scheduledRun;
  }

  diagnostics(): BoxStoreSyncMetrics {
    return { ...this.metrics };
  }

  private startScheduledRun(): void {
    if (this.scheduledRun) {
      this.scheduledRerun = true;
      return;
    }
    const run = this.runScheduledSnapshots();
    this.scheduledRun = run;
    void run
      .catch((error) => console.warn("box-store snapshot", error))
      .finally(() => {
        if (this.scheduledRun === run) this.scheduledRun = null;
        if (
          this.pendingFullSnapshot ||
          this.pendingDirtyPrefixes.size > 0 ||
          this.pendingChromeSnapshot
        ) {
          this.startScheduledRun();
        }
      });
  }

  private async runScheduledSnapshots(): Promise<void> {
    do {
      this.scheduledRerun = false;
      const hint = this.consumeDirtyHint();
      try {
        await this.snapshotOut(hint);
      } catch (error) {
        console.warn("box-store snapshot", error);
      }
    } while (
      this.scheduledRerun ||
      this.pendingFullSnapshot ||
      this.pendingDirtyPrefixes.size > 0 ||
      this.pendingChromeSnapshot
    );
  }

  private mergeDirtyHint(hint: BoxStoreDirtyHint): void {
    if (
      hint.all !== false &&
      !hint.sand &&
      !hint.workspace &&
      !hint.pi &&
      !hint.chrome &&
      !hint.agentIds?.length &&
      !hint.sandPaths?.length
    ) {
      this.pendingFullSnapshot = true;
      this.pendingDirtyPrefixes.clear();
      this.pendingChromeSnapshot = false;
      return;
    }
    if (hint.all) {
      this.pendingFullSnapshot = true;
      this.pendingDirtyPrefixes.clear();
      this.pendingChromeSnapshot = false;
      return;
    }
    if (this.pendingFullSnapshot) return;
    if (hint.sand) this.pendingDirtyPrefixes.add("home/box/sand-data");
    if (hint.workspace) this.pendingDirtyPrefixes.add("workspace");
    if (hint.pi) this.pendingDirtyPrefixes.add("home/box/.pi/agent");
    for (const agentId of hint.agentIds ?? []) {
      if (!agentId || agentId === "." || agentId === ".." || /[\\/\0]/.test(agentId)) continue;
      this.pendingDirtyPrefixes.add(`home/box/sand-data/agents/${agentId}`);
    }
    for (const sandPath of hint.sandPaths ?? []) {
      const segments = sandPath.split("/");
      if (
        segments.length === 0 ||
        segments.some(
          (segment) => !segment || segment === "." || segment === ".." || /[\\\0]/.test(segment)
        )
      ) {
        continue;
      }
      this.pendingDirtyPrefixes.add(`home/box/sand-data/${segments.join("/")}`);
    }
    if (hint.chrome) this.pendingChromeSnapshot = true;
  }

  private consumeDirtyHint(): BoxStoreDirtyHint {
    if (this.pendingFullSnapshot) {
      this.pendingFullSnapshot = false;
      this.pendingDirtyPrefixes.clear();
      this.pendingChromeSnapshot = false;
      return { all: true };
    }
    const prefixes = collapseLogicalPrefixes(this.pendingDirtyPrefixes);
    this.pendingDirtyPrefixes.clear();
    const chrome = this.pendingChromeSnapshot;
    this.pendingChromeSnapshot = false;
    return {
      all: false,
      sand: prefixes.includes("home/box/sand-data"),
      workspace: prefixes.includes("workspace"),
      pi: prefixes.includes("home/box/.pi/agent"),
      agentIds: prefixes.flatMap((prefix) => {
        const match = prefix.match(/^home\/box\/sand-data\/agents\/([^/]+)$/);
        return match?.[1] ? [match[1]] : [];
      }),
      sandPaths: prefixes.flatMap((prefix) => {
        if (
          !prefix.startsWith("home/box/sand-data/") ||
          prefix.startsWith("home/box/sand-data/agents/")
        )
          return [];
        return [prefix.slice("home/box/sand-data/".length)];
      }),
      chrome,
    };
  }

  async snapshotOut(hint: BoxStoreDirtyHint = { all: true }): Promise<BoxStoreManifest> {
    this.metrics.snapshotRuns += 1;
    const startingManifest = await this.readManifest();
    const startingEtag = startingManifest?.etag ?? null;
    const signatureCache = await this.readSignatureCache(startingEtag);
    const sources = await this.sources();
    const hasSpecificHint = Boolean(
      hint.sand ||
        hint.workspace ||
        hint.pi ||
        hint.chrome ||
        hint.agentIds?.length ||
        hint.sandPaths?.length
    );
    const fullSnapshot =
      hint.all === true || !hasSpecificHint || !startingManifest || !signatureCache;
    const dirtyPrefixes = fullSnapshot
      ? sources.map(({ logical }) => logical)
      : this.dirtyPrefixesForHint(hint, sources, startingManifest);
    const previousFiles = new Map(
      (startingManifest?.files ?? []).map((file) => [file.path, file] as const)
    );
    const filesByPath = fullSnapshot ? new Map<string, ManifestFile>() : new Map(previousFiles);
    const nextSignatures = new Map<string, string>();
    if (!fullSnapshot && signatureCache) {
      for (const [path, signature] of Object.entries(signatureCache.signatures)) {
        if (!dirtyPrefixes.some((prefix) => logicalContains(prefix, path))) {
          nextSignatures.set(path, signature);
        }
      }
    }
    for (const prefix of dirtyPrefixes) {
      for (const path of filesByPath.keys()) {
        if (logicalContains(prefix, path)) filesByPath.delete(path);
      }
      for (const path of nextSignatures.keys()) {
        if (logicalContains(prefix, path)) nextSignatures.delete(path);
      }
    }
    const targets = this.collectionTargets(dirtyPrefixes, sources);
    for (const target of targets) {
      await this.collect(
        target.path,
        target.logical,
        filesByPath,
        previousFiles,
        signatureCache?.signatures ?? {},
        nextSignatures
      );
    }
    const files = [...filesByPath.values()];
    files.sort((left, right) => left.path.localeCompare(right.path));
    const livePaths = new Set(files.map(({ path }) => path));
    const priorTombstones = startingManifest?.tombstones ?? [];
    const priorTombstonePaths = new Set(priorTombstones.map(({ path }) => path));
    const tombstones = [
      ...priorTombstones.filter(({ path }) => !livePaths.has(path)),
      ...(startingManifest?.files ?? [])
        .filter(({ path }) => !livePaths.has(path) && !priorTombstonePaths.has(path))
        .map(({ path }) => ({ path, deletedAt: new Date().toISOString() })),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const base = {
      version: 1 as const,
      revision: (startingManifest?.revision ?? 0) + 1,
      generatedAt: new Date().toISOString(),
      files,
      tombstones,
    };
    const manifest: BoxStoreManifest = { ...base, etag: manifestEtag(base) };
    const current = await this.readManifest();
    if ((current?.etag ?? null) !== startingEtag) {
      const conflict = join(this.storeRoot, `conflict.manifest-${Date.now()}.json`);
      await atomicWrite(conflict, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
      throw new Error("box-store manifest changed during snapshot; wrote a conflict manifest");
    }
    await atomicWrite(
      this.manifestPath,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    );
    const nextCache: SnapshotSignatureCache = {
      version: 1,
      manifestEtag: manifest.etag,
      signatures: Object.fromEntries(
        files.flatMap((file) => {
          const signature = nextSignatures.get(file.path);
          return signature ? [[file.path, signature]] : [];
        })
      ),
    };
    await atomicWrite(
      this.signatureCachePath,
      Buffer.from(`${JSON.stringify(nextCache)}\n`, "utf8")
    ).catch((error) => console.warn("box-store signature cache", error));
    return manifest;
  }

  async copyIn(): Promise<{ copied: number; skipped: number }> {
    const manifest = await this.readManifest();
    if (!manifest) return { copied: 0, skipped: 0 };
    let copied = 0;
    let skipped = 0;
    for (const tombstone of manifest.tombstones ?? []) {
      const agentId = this.agentIdForLogicalPath(tombstone.path);
      if (agentId && this.hasLiveAgentHandle(agentId)) {
        throw new Error(`box-store refused a live-agent tombstone: ${agentId}`);
      }
      await rm(this.targetFor(tombstone.path), { recursive: true, force: true });
    }
    const orderedFiles = [...manifest.files].sort(
      (left, right) =>
        Number(COPY_IN_CRITICAL_BASENAMES.has(basename(right.path))) -
          Number(COPY_IN_CRITICAL_BASENAMES.has(basename(left.path))) ||
        left.path.localeCompare(right.path)
    );
    for (const file of orderedFiles) {
      const target = this.targetFor(file.path);
      const existing = await readFile(target).catch(() => null);
      if (existing && digest(existing) === file.sha256) {
        skipped += 1;
        continue;
      }
      const agentId = this.agentIdForLogicalPath(file.path);
      if (agentId && sqliteName(basename(file.path)) && this.hasLiveAgentHandle(agentId)) {
        throw new Error(`box-store refused to replace a live agent database: ${agentId}`);
      }
      const blob = await readFile(join(this.blobsRoot, file.sha256));
      if (digest(blob) !== file.sha256) throw new Error(`box-store blob failed hash: ${file.path}`);
      await atomicWrite(target, blob, file.mode);
      await chmod(target, file.mode).catch(() => undefined);
      copied += 1;
    }
    return { copied, skipped };
  }

  private async sources(): Promise<Array<{ path: string; logical: string }>> {
    const sources = [
      { path: this.sandRoot, logical: "home/box/sand-data" },
      { path: this.workspaceRoot, logical: "workspace" },
      { path: join(this.home, ".pi", "agent"), logical: "home/box/.pi/agent" },
      {
        path: join(this.home, ".openbot", "browser-authority.key"),
        logical: "home/box/.openbot/browser-authority.key",
      },
      {
        path: join(this.home, ".openbot", "browser-authority.json.enc"),
        logical: "home/box/.openbot/browser-authority.json.enc",
      },
      {
        path: join(this.home, ".openbot", "browser-profile-authority"),
        logical: "home/box/.openbot/browser-profile-authority",
      },
      { path: join(this.home, ".pki", "nssdb"), logical: "home/box/.pki/nssdb" },
    ];
    const homeEntries = await readdir(this.home, { withFileTypes: true }).catch(() => []);
    for (const entry of homeEntries) {
      if (entry.isDirectory() && /^chrome-profile(?:-\d+)?$/.test(entry.name)) {
        sources.push({ path: join(this.home, entry.name), logical: `home/box/${entry.name}` });
      }
    }
    return sources;
  }

  private dirtyPrefixesForHint(
    hint: BoxStoreDirtyHint,
    sources: Array<{ path: string; logical: string }>,
    manifest: BoxStoreManifest
  ): string[] {
    const prefixes = new Set<string>();
    if (hint.sand) prefixes.add("home/box/sand-data");
    if (hint.workspace) prefixes.add("workspace");
    if (hint.pi) prefixes.add("home/box/.pi/agent");
    for (const agentId of hint.agentIds ?? []) {
      if (!agentId || agentId === "." || agentId === ".." || /[\\/\0]/.test(agentId)) continue;
      prefixes.add(`home/box/sand-data/agents/${agentId}`);
    }
    for (const sandPath of hint.sandPaths ?? []) {
      const segments = sandPath.split("/");
      if (
        segments.length === 0 ||
        segments.some(
          (segment) => !segment || segment === "." || segment === ".." || /[\\\0]/.test(segment)
        )
      ) {
        continue;
      }
      prefixes.add(`home/box/sand-data/${segments.join("/")}`);
    }
    if (hint.chrome) {
      for (const source of sources) {
        if (
          /^home\/box\/chrome-profile(?:-\d+)?$/.test(source.logical) ||
          /^home\/box\/\.openbot\/browser-(?:authority(?:\.key|\.json\.enc)?|profile-authority)$/.test(
            source.logical
          ) ||
          source.logical === "home/box/.pki/nssdb"
        ) {
          prefixes.add(source.logical);
        }
      }
      for (const file of manifest.files) {
        const match = file.path.match(
          /^(home\/box\/(?:chrome-profile(?:-\d+)?|\.openbot\/browser-(?:authority(?:\.key|\.json\.enc)?|profile-authority)|\.pki\/nssdb))(?:\/|$)/
        );
        if (match?.[1]) prefixes.add(match[1]);
      }
    }
    return collapseLogicalPrefixes(prefixes);
  }

  private collectionTargets(
    dirtyPrefixes: readonly string[],
    sources: Array<{ path: string; logical: string }>
  ): Array<{ path: string; logical: string }> {
    const targets: Array<{ path: string; logical: string }> = [];
    for (const prefix of dirtyPrefixes) {
      const source = sources.find(({ logical }) => logicalContains(logical, prefix));
      if (!source) continue;
      const suffix = prefix.slice(source.logical.length).replace(/^\//, "");
      const segments = suffix ? suffix.split("/") : [];
      if (
        segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment)) ||
        segments.some(
          (segment) =>
            temporaryName(segment) || sqliteSidecar(segment) || sqliteRecoveryArtifact(segment)
        )
      ) {
        continue;
      }
      const path = segments.length ? resolve(source.path, ...segments) : source.path;
      const difference = relative(source.path, path);
      if (difference === ".." || difference.startsWith(`..${sep}`)) continue;
      targets.push({ path, logical: prefix });
    }
    return targets.filter(
      (target, index) =>
        !targets.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index &&
            logicalContains(candidate.logical, target.logical) &&
            candidate.logical.length < target.logical.length
        )
    );
  }

  private async collect(
    path: string,
    logical: string,
    files: Map<string, ManifestFile>,
    previousFiles: Map<string, ManifestFile>,
    previousSignatures: Record<string, string>,
    nextSignatures: Map<string, string>
  ): Promise<void> {
    const info = await lstat(path, { bigint: true }).catch(() => null);
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(basename(path))) return;
      this.metrics.directoriesVisited += 1;
      for (const entry of await readdir(path)) {
        if (temporaryName(entry) || sqliteSidecar(entry) || sqliteRecoveryArtifact(entry)) continue;
        await this.collect(
          join(path, entry),
          `${logical}/${entry}`,
          files,
          previousFiles,
          previousSignatures,
          nextSignatures
        );
      }
      return;
    }
    if (!info.isFile()) return;
    this.metrics.sourceFilesInspected += 1;
    const signature = await this.sourceSignature(path, info, sqliteName(basename(path)));
    const previous = previousFiles.get(logical);
    if (
      previous &&
      previousSignatures[logical] === signature &&
      (await stat(join(this.blobsRoot, previous.sha256)).catch(() => null))
    ) {
      files.set(logical, previous);
      nextSignatures.set(logical, signature);
      this.metrics.signatureReuses += 1;
      return;
    }
    const bytes = sqliteName(basename(path))
      ? await this.sqliteSnapshot(path)
      : await readFile(path);
    this.metrics.sourceFilesRead += 1;
    this.metrics.sourceBytesRead += bytes.byteLength;
    const sha256 = digest(bytes);
    this.metrics.contentHashes += 1;
    await this.storeBlob(sha256, bytes);
    files.set(logical, {
      path: logical,
      sha256,
      size: bytes.byteLength,
      mode: Number(info.mode & 0o777n),
    });
    nextSignatures.set(logical, signature);
  }

  private async sourceSignature(
    path: string,
    info: Awaited<ReturnType<typeof lstat>> & { mtimeNs: bigint; ctimeNs: bigint },
    sqlite: boolean
  ): Promise<string> {
    const base = [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");
    if (!sqlite) return base;
    const wal = await stat(`${path}-wal`, { bigint: true }).catch(() => null);
    const walSignature = wal
      ? [wal.dev, wal.ino, wal.size, wal.mode, wal.mtimeNs, wal.ctimeNs].join(":")
      : "missing";
    return `${base}|wal:${walSignature}`;
  }

  private async sqliteSnapshot(path: string): Promise<Buffer> {
    const sidecars = [`${path}-wal`, `${path}-shm`];
    const unopenedStoreMarkers = [...sidecars, join(dirname(path), "conversation-blobs.db")];
    if (
      basename(path) === "store.db" &&
      (
        await Promise.all(
          unopenedStoreMarkers.map((candidate) => stat(candidate).catch(() => null))
        )
      ).every((entry) => entry === null)
    ) {
      const bytes = await readFile(path);
      const stayedUnopened = (
        await Promise.all(
          unopenedStoreMarkers.map((candidate) => stat(candidate).catch(() => null))
        )
      ).every((entry) => entry === null);
      if (stayedUnopened) return bytes;
    }
    const temporary = join(dirname(path), `.box-store-snap-${randomUUID()}`);
    const database = new Database(path, { readonly: true, strict: true });
    try {
      this.metrics.sqliteVacuums += 1;
      database.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
      return await readFile(temporary);
    } finally {
      database.close(false);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async storeBlob(sha256: string, bytes: Uint8Array): Promise<void> {
    const target = join(this.blobsRoot, sha256);
    if (await stat(target).catch(() => null)) return;
    try {
      await atomicWrite(target, bytes);
    } catch (error) {
      if (!(await stat(target).catch(() => null))) throw error;
    }
  }

  private async readManifest(): Promise<BoxStoreManifest | null> {
    const bytes = await readFile(this.manifestPath).catch(() => null);
    if (!bytes) return null;
    const manifest = JSON.parse(bytes.toString("utf8")) as BoxStoreManifest;
    if (
      manifest.version !== 1 ||
      !Number.isInteger(manifest.revision) ||
      !Array.isArray(manifest.files) ||
      (manifest.tombstones !== undefined && !Array.isArray(manifest.tombstones)) ||
      manifest.etag !==
        manifestEtag({
          version: 1,
          revision: manifest.revision,
          generatedAt: manifest.generatedAt,
          files: manifest.files,
          ...(manifest.tombstones ? { tombstones: manifest.tombstones } : {}),
        })
    ) {
      throw new Error("box-store manifest is malformed or failed its etag check");
    }
    return manifest;
  }

  private async readSignatureCache(
    manifestEtag: string | null
  ): Promise<SnapshotSignatureCache | null> {
    if (!manifestEtag) return null;
    const bytes = await readFile(this.signatureCachePath).catch(() => null);
    if (!bytes) return null;
    try {
      const value = JSON.parse(bytes.toString("utf8")) as SnapshotSignatureCache;
      if (
        value.version !== 1 ||
        value.manifestEtag !== manifestEtag ||
        !value.signatures ||
        typeof value.signatures !== "object" ||
        Array.isArray(value.signatures) ||
        Object.entries(value.signatures).some(
          ([path, signature]) => !path || typeof signature !== "string" || !signature
        )
      ) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  private targetFor(logical: string): string {
    const mappings = [
      ["home/box/sand-data", this.sandRoot],
      ["home/box/.pi/agent", join(this.home, ".pi", "agent")],
      ["home/box", this.home],
      ["workspace", this.workspaceRoot],
    ] as const;
    for (const [prefix, root] of mappings) {
      if (logical === prefix) return resolve(root);
      if (!logical.startsWith(`${prefix}/`)) continue;
      const target = resolve(root, logical.slice(prefix.length + 1));
      const difference = relative(resolve(root), target);
      if (difference === ".." || difference.startsWith(`..${sep}`)) break;
      return target;
    }
    throw new Error(`box-store manifest path escaped an allowed root: ${logical}`);
  }

  private agentIdForLogicalPath(logical: string): string | null {
    return logical.match(/^home\/box\/sand-data\/agents\/([^/]+)\//)?.[1] ?? null;
  }

  private async repairTemporaryFiles(): Promise<void> {
    const sourceCandidates = (await this.sources()).map(({ path }) => resolve(path));
    const sourceRoots = (
      await Promise.all(
        sourceCandidates.map(async (path) => ((await lstat(path).catch(() => null)) ? path : null))
      )
    )
      .filter((path): path is string => path !== null)
      .sort((left, right) => left.length - right.length || left.localeCompare(right))
      .filter(
        (path, index, paths) =>
          !paths.some((parent, parentIndex) => {
            if (parentIndex === index || parent.length >= path.length) return false;
            const difference = relative(parent, path);
            return difference !== ".." && !difference.startsWith(`..${sep}`);
          })
      );
    const roots = [
      { path: this.storeRoot, recursive: false },
      { path: this.blobsRoot, recursive: false },
      ...sourceRoots.map((path) => ({ path, recursive: true })),
    ];
    this.metrics.repairRoots += roots.length;
    for (const root of roots) await this.repairTemporaryTree(root.path, root.recursive);
  }

  private async repairTemporaryTree(root: string, recursive: boolean): Promise<void> {
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) continue;
      this.metrics.repairDirectoriesVisited += 1;
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        this.metrics.repairEntriesInspected += 1;
        const path = join(directory, entry.name);
        if (temporaryName(entry.name)) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (
          recursive &&
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !EXCLUDED_DIRECTORY_NAMES.has(entry.name)
        ) {
          pending.push(path);
        }
      }
    }
  }
}
