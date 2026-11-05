import {
  boxStoreFreeSpaceShortfall,
  collectBoxStoreBlobsLocked,
  PRESSURE_RETENTION_MS,
  withBoxStoreOperation,
} from "./box-store/garbage-collection";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileDigest, stageFile, STREAM_FILE_THRESHOLD } from "./box-store/file-stream";
import {
  type BoxStoreDirtyHint,
  type BoxStoreManifest,
  type BoxStoreSyncMetrics,
  type ManifestFile,
  type SnapshotSignatureCache,
  atomicWrite,
  collapseLogicalPrefixes,
  COPY_IN_CRITICAL_BASENAMES,
  digest,
  EXCLUDED_DIRECTORY_NAMES,
  excludedDirectory,
  logicalContains,
  manifestEtag,
  sqliteName,
  sqliteRecoveryArtifact,
  sqliteSidecar,
  temporaryName,
} from "./box-store/manifest";

const CHROME_PROFILE_SOURCE = /^home\/box\/chrome-profile(?:-\d+)?$/;
const CHROME_PROFILE_NAME = /^chrome-profile(?:-\d+)?$/;
const BROWSER_STATE_SOURCE =
  /^home\/box\/(?:chrome-profile(?:-\d+)?|\.openteam\/browser-(?:authority(?:\.key|\.json\.enc|\.parts)?|profile-authority)|\.pki\/nssdb)$/;
const BROWSER_STATE_FILE =
  /^(home\/box\/(?:chrome-profile(?:-\d+)?|\.openteam\/browser-(?:authority(?:\.key|\.json\.enc|\.parts)?|profile-authority)|\.pki\/nssdb))(?:\/|$)/;
/** How often a periodic snapshot recaptures a profile whose Chromium is still running. */
export const CHROME_PROFILE_SNAPSHOT_INTERVAL_MS = 30 * 60_000;

type SnapshotContent = Buffer | Awaited<ReturnType<typeof stageFile>>;

export class BoxStoreSync {
  private readonly storeRoot: string;
  private readonly manifestPath: string;
  private readonly signatureCachePath: string;
  private readonly blobsRoot: string;
  private readonly home: string;
  private readonly sandRoot: string;
  private readonly workspaceRoot: string;
  private readonly hasLiveAgentHandle: (agentId: string) => boolean;
  private lastBlobCollection = 0;
  private collectionPressure = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private scheduledRun: Promise<void> | null = null;
  private scheduledRerun = false;
  private pendingFullSnapshot = false;
  private readonly pendingDirtyPrefixes = new Set<string>();
  private pendingChromeSnapshot = false;
  private readonly pendingChromeProfiles = new Set<string>();
  private readonly chromeProfileIntervalMs: number;
  private readonly chromeProfileCapturedAt = new Map<string, number>();
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
      chromeProfileIntervalMs?: number;
    } = {}
  ) {
    this.storeRoot = resolve(
      options.storeRoot ?? process.env.OPENTEAM_BOX_STORE_ROOT ?? "/box-store"
    );
    this.manifestPath = join(this.storeRoot, "manifest.json");
    this.signatureCachePath = join(this.storeRoot, ".snapshot-signatures.json");
    this.blobsRoot = join(this.storeRoot, "blobs");
    this.home = resolve(options.home ?? process.env.HOME ?? "/home/box");
    this.sandRoot = resolve(
      options.sandRoot ?? process.env.OPENTEAM_AGENT_DATA_CANONICAL_ROOT ?? "/home/box/sand-data"
    );
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? process.env.OPENTEAM_WORKSPACE_ROOT ?? "/workspace"
    );
    this.hasLiveAgentHandle = options.hasLiveAgentHandle ?? (() => false);
    this.chromeProfileIntervalMs =
      options.chromeProfileIntervalMs ?? CHROME_PROFILE_SNAPSHOT_INTERVAL_MS;
  }

  async start(): Promise<void> {
    await mkdir(this.blobsRoot, { recursive: true, mode: 0o700 });
    await withBoxStoreOperation(this.storeRoot, () => this.repairTemporaryFiles());
    if (process.env.OPENTEAM_BOX_COPY_IN === "1") await this.copyIn();
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
          this.pendingChromeSnapshot ||
          this.pendingChromeProfiles.size > 0
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
      this.pendingChromeSnapshot ||
      this.pendingChromeProfiles.size > 0
    );
  }

  private mergeDirtyHint(hint: BoxStoreDirtyHint): void {
    // A full snapshot may defer running browser profiles, so an explicit
    // browser request must survive being merged into one.
    if (hint.chrome) this.pendingChromeSnapshot = true;
    for (const name of hint.chromeProfiles ?? []) {
      if (CHROME_PROFILE_NAME.test(name)) this.pendingChromeProfiles.add(name);
    }
    if (
      hint.all !== false &&
      !hint.sand &&
      !hint.workspace &&
      !hint.pi &&
      !hint.chrome &&
      !hint.chromeProfiles?.length &&
      !hint.agentIds?.length &&
      !hint.sandPaths?.length
    ) {
      this.pendingFullSnapshot = true;
      this.pendingDirtyPrefixes.clear();
      return;
    }
    if (hint.all) {
      this.pendingFullSnapshot = true;
      this.pendingDirtyPrefixes.clear();
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
  }

  private consumeDirtyHint(): BoxStoreDirtyHint {
    const chrome = this.pendingChromeSnapshot;
    // A whole-browser request already captures every profile.
    const chromeProfiles = chrome ? [] : [...this.pendingChromeProfiles].sort();
    this.pendingChromeSnapshot = false;
    this.pendingChromeProfiles.clear();
    const profiles = chromeProfiles.length ? { chromeProfiles } : {};
    if (this.pendingFullSnapshot) {
      this.pendingFullSnapshot = false;
      this.pendingDirtyPrefixes.clear();
      return chrome ? { all: true, chrome } : { all: true, ...profiles };
    }
    const prefixes = collapseLogicalPrefixes(this.pendingDirtyPrefixes);
    this.pendingDirtyPrefixes.clear();
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
      ...profiles,
    };
  }

  async snapshotOut(hint: BoxStoreDirtyHint = { all: true }): Promise<BoxStoreManifest> {
    return withBoxStoreOperation(this.storeRoot, async () => {
      try {
        return await this.snapshotOutLocked(hint);
      } finally {
        // Collect after failed snapshots too: on a full disk every snapshot
        // fails, and collection is the only thing that frees space.
        // Collection is hourly, and every few minutes while unreferenced
        // blobs are over budget or the disk is low.
        const elapsed = Date.now() - this.lastBlobCollection;
        if (
          elapsed >= 60 * 60_000 ||
          (elapsed >= PRESSURE_RETENTION_MS &&
            (this.collectionPressure || (await boxStoreFreeSpaceShortfall(this.storeRoot)) > 0))
        ) {
          try {
            const collection = await collectBoxStoreBlobsLocked(this.storeRoot);
            this.lastBlobCollection = Date.now();
            this.collectionPressure = collection.pressure;
            if (collection.deleted) console.info(JSON.stringify({event: "box_store.collection", ...collection}));
          } catch (error) {
            // Snapshot publication remains valid even if optional maintenance fails.
            console.warn("box-store collection", error);
          }
        }
      }
    });
  }

  private async snapshotOutLocked(hint: BoxStoreDirtyHint): Promise<BoxStoreManifest> {
    this.metrics.snapshotRuns += 1;
    const startedAt = Date.now();
    const startingManifest = await this.readManifest();
    const startingEtag = startingManifest?.etag ?? null;
    const signatureCache = await this.readSignatureCache(startingEtag);
    const sources = await this.sources();
    const hasSpecificHint = Boolean(
      hint.sand ||
        hint.workspace ||
        hint.pi ||
        hint.chrome ||
        hint.chromeProfiles?.length ||
        hint.agentIds?.length ||
        hint.sandPaths?.length
    );
    const fullSnapshot =
      hint.all === true || !hasSpecificHint || !startingManifest || !signatureCache;
    // Profiles deferred by a full snapshot keep their previous entries, exactly
    // like clean roots in a partial snapshot.
    const deferredProfiles =
      fullSnapshot && !hint.chrome && startingManifest && signatureCache
        ? (await this.deferredChromeProfiles(sources, startedAt)).filter(
            (logical) => !hint.chromeProfiles?.includes(logical.slice("home/box/".length))
          )
        : [];
    const dirtyPrefixes = fullSnapshot
      ? sources
          .map(({ logical }) => logical)
          .filter((logical) => !deferredProfiles.includes(logical))
      : this.dirtyPrefixesForHint(hint, sources, startingManifest);
    const retained = (path: string): boolean =>
      fullSnapshot
        ? deferredProfiles.some((prefix) => logicalContains(prefix, path))
        : !dirtyPrefixes.some((prefix) => logicalContains(prefix, path));
    const previousFiles = new Map(
      (startingManifest?.files ?? []).map((file) => [file.path, file] as const)
    );
    const filesByPath = new Map([...previousFiles].filter(([path]) => retained(path)));
    const nextSignatures = new Map<string, string>();
    for (const [path, signature] of Object.entries(signatureCache?.signatures ?? {})) {
      if (retained(path)) nextSignatures.set(path, signature);
    }
    const targets = this.collectionTargets(dirtyPrefixes, sources);
    const capturedProfiles = sources
      .map(({ logical }) => logical)
      .filter(
        (logical) =>
          CHROME_PROFILE_SOURCE.test(logical) &&
          dirtyPrefixes.some((prefix) => logicalContains(prefix, logical))
      );
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
    for (const logical of capturedProfiles) this.chromeProfileCapturedAt.set(logical, startedAt);
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
    return withBoxStoreOperation(this.storeRoot, () => this.copyInLocked());
  }

  private async copyInLocked(): Promise<{ copied: number; skipped: number }> {
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
      const existingHash = file.size > STREAM_FILE_THRESHOLD
        ? await fileDigest(target).catch(() => null)
        : await readFile(target).then(digest).catch(() => null);
      if (existingHash === file.sha256) {
        skipped += 1;
        continue;
      }
      const agentId = this.agentIdForLogicalPath(file.path);
      if (agentId && sqliteName(basename(file.path)) && this.hasLiveAgentHandle(agentId)) {
        throw new Error(`box-store refused to replace a live agent database: ${agentId}`);
      }
      const blobPath = join(this.blobsRoot, file.sha256);
      if (file.size > STREAM_FILE_THRESHOLD) {
        const staged = await stageFile(blobPath, dirname(target), file.mode);
        try {
          if (staged.sha256 !== file.sha256) throw new Error(`box-store blob failed hash: ${file.path}`);
          await rename(staged.path, target);
        } finally {
          await rm(staged.path, { force: true }).catch(() => undefined);
        }
      } else {
        const blob = await readFile(blobPath);
        if (digest(blob) !== file.sha256) throw new Error(`box-store blob failed hash: ${file.path}`);
        await atomicWrite(target, blob, file.mode);
      }
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
        path: join(this.home, ".openteam", "browser-authority.key"),
        logical: "home/box/.openteam/browser-authority.key",
      },
      {
        path: join(this.home, ".openteam", "browser-authority.json.enc"),
        logical: "home/box/.openteam/browser-authority.json.enc",
      },
      {
        path: join(this.home, ".openteam", "browser-authority.parts"),
        logical: "home/box/.openteam/browser-authority.parts",
      },
      {
        path: join(this.home, ".openteam", "browser-profile-authority"),
        logical: "home/box/.openteam/browser-profile-authority",
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

  /**
   * A running Chromium rewrites parts of its profile every few minutes even
   * while idle (extension and IndexedDB LevelDB logs, cookie and quota
   * databases), and each changed file is stored whole. Full snapshots therefore capture a running browser's profile
   * at most once per interval. Explicit browser hints and the shutdown snapshot
   * still capture it, and once the browser exits (Chromium removes its
   * SingletonLock) the next periodic snapshot does too. The live profile itself
   * stays on the home volume across restarts.
   */
  private async deferredChromeProfiles(
    sources: Array<{ path: string; logical: string }>,
    now: number
  ): Promise<string[]> {
    const deferred: string[] = [];
    for (const { path, logical } of sources) {
      if (!CHROME_PROFILE_SOURCE.test(logical)) continue;
      const capturedAt = this.chromeProfileCapturedAt.get(logical);
      if (capturedAt === undefined || now - capturedAt >= this.chromeProfileIntervalMs) continue;
      if (await lstat(join(path, "SingletonLock")).catch(() => null)) deferred.push(logical);
    }
    return deferred;
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
    if (hint.chrome || hint.chromeProfiles?.length) {
      // A request for one profile still captures the shared sign-in state.
      const requested = (root: string) =>
        hint.chrome ||
        !CHROME_PROFILE_SOURCE.test(root) ||
        Boolean(hint.chromeProfiles?.includes(root.slice("home/box/".length)));
      for (const source of sources) {
        if (BROWSER_STATE_SOURCE.test(source.logical) && requested(source.logical)) {
          prefixes.add(source.logical);
        }
      }
      for (const file of manifest.files) {
        const root = file.path.match(BROWSER_STATE_FILE)?.[1];
        if (root && requested(root)) prefixes.add(root);
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
        segments.some((_, index) =>
          excludedDirectory([source.logical, ...segments.slice(0, index + 1)].join("/"))
        ) ||
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
      if (excludedDirectory(logical)) return;
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
    let content: SnapshotContent;
    let snapshotSignature = signature;
    if (sqliteName(basename(path))) {
      const snapshot = await this.sqliteSnapshot(path, info);
      content = snapshot.content;
      snapshotSignature = snapshot.signature ?? signature;
    } else {
      content =
        info.size > BigInt(STREAM_FILE_THRESHOLD)
          ? await stageFile(path, this.blobsRoot)
          : await readFile(path);
    }
    const size = Buffer.isBuffer(content) ? content.byteLength : content.size;
    const sha256 = Buffer.isBuffer(content) ? digest(content) : content.sha256;
    if (Buffer.isBuffer(content)) await this.storeBlob(sha256, content);
    else await this.storeStagedBlob(content);
    this.metrics.sourceFilesRead += 1;
    this.metrics.sourceBytesRead += size;
    this.metrics.contentHashes += 1;
    files.set(logical, {
      path: logical,
      sha256,
      size,
      mode: Number(info.mode & 0o777n),
    });
    nextSignatures.set(logical, snapshotSignature);
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

  private async sqliteSnapshot(
    path: string,
    identity: { dev: bigint; ino: bigint; mode: bigint }
  ): Promise<{ content: SnapshotContent; signature?: string }> {
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
      const content = await this.sqliteSnapshotContent(path);
      const stayedUnopened = (
        await Promise.all(
          unopenedStoreMarkers.map((candidate) => stat(candidate).catch(() => null))
        )
      ).every((entry) => entry === null);
      if (stayedUnopened) return { content };
      if (!Buffer.isBuffer(content)) await rm(content.path, { force: true });
    }
    const temporary = join(dirname(path), `.box-store-snap-${randomUUID()}`);
    const database = new Database(path, { readonly: true, strict: true });
    try {
      const version = () =>
        (database.query("PRAGMA data_version").get() as { data_version: number }).data_version;
      const before = version();
      this.metrics.sqliteVacuums += 1;
      database.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
      const content = await this.sqliteSnapshotContent(temporary);
      // Opening the WAL may change its ctime even without a commit (Linux).
      // Refresh the signature only if this same database stayed unchanged
      // through the snapshot and the final stat; otherwise the next scan retries.
      let signature: string | undefined;
      try {
        const current = await lstat(path, { bigint: true });
        if (
          current.dev === identity.dev &&
          current.ino === identity.ino &&
          current.mode === identity.mode
        ) {
          const observed = await this.sourceSignature(path, current, true);
          if (version() === before) signature = observed;
        }
      } catch {
        // A concurrent removal/replacement must not mark newer state as saved.
      }
      return { content, signature };
    } finally {
      database.close(false);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async sqliteSnapshotContent(path: string): Promise<SnapshotContent> {
    return (await stat(path)).size > STREAM_FILE_THRESHOLD
      ? stageFile(path, this.blobsRoot)
      : readFile(path);
  }

  private async storeStagedBlob(staged: Awaited<ReturnType<typeof stageFile>>): Promise<void> {
    try {
      const target = join(this.blobsRoot, staged.sha256);
      if (await stat(target).catch(() => null)) {
        const now = new Date();
        await utimes(target, now, now);
      } else {
        await rename(staged.path, target);
      }
    } finally {
      await rm(staged.path, { force: true }).catch(() => undefined);
    }
  }

  private async storeBlob(sha256: string, bytes: Uint8Array): Promise<void> {
    const target = join(this.blobsRoot, sha256);
    if (await stat(target).catch(() => null)) {
      // Reintroduction can occur between collection scans. Restart its grace
      // period even if the same content hash already existed as an orphan.
      const now = new Date();
      await utimes(target, now, now);
      return;
    }
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
export {
  type BoxStoreDirtyHint,
  type BoxStoreManifest,
  type BoxStoreSyncMetrics,
  type ManifestFile,
} from "./box-store/manifest";
