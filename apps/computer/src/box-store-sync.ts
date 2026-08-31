import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";

interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

interface ManifestTombstone {
  path: string;
  deletedAt: string;
}

interface BoxStoreManifest {
  version: 1;
  revision: number;
  generatedAt: string;
  files: ManifestFile[];
  tombstones?: ManifestTombstone[];
  etag: string;
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
  let handle;
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
  private readonly blobsRoot: string;
  private readonly home: string;
  private readonly sandRoot: string;
  private readonly workspaceRoot: string;
  private readonly hasLiveAgentHandle: (agentId: string) => boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private tail: Promise<void> = Promise.resolve();

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
    this.periodic = setInterval(() => this.scheduleSnapshot(0), 120_000);
    this.periodic.unref?.();
  }

  scheduleSnapshot(delayMs = 5_000): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tail = this.tail.then(
        () => this.snapshotOut().then(() => undefined),
        () => this.snapshotOut().then(() => undefined)
      );
      void this.tail.catch((error) => console.warn("box-store snapshot", error));
    }, delayMs);
    this.timer.unref?.();
  }

  async snapshotOut(): Promise<BoxStoreManifest> {
    const startingManifest = await this.readManifest();
    const startingEtag = startingManifest?.etag ?? null;
    const files: ManifestFile[] = [];
    for (const source of await this.sources())
      await this.collect(source.path, source.logical, files);
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
    ];
    const homeEntries = await readdir(this.home, { withFileTypes: true }).catch(() => []);
    for (const entry of homeEntries) {
      if (entry.isDirectory() && /^chrome-profile(?:-\d+)?$/.test(entry.name)) {
        sources.push({ path: join(this.home, entry.name), logical: `home/box/${entry.name}` });
      }
    }
    return sources;
  }

  private async collect(path: string, logical: string, files: ManifestFile[]): Promise<void> {
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      if (["node_modules", ".git", "Cache", "Code Cache", "GPUCache"].includes(basename(path))) {
        return;
      }
      for (const entry of await readdir(path)) {
        if (temporaryName(entry) || sqliteSidecar(entry) || sqliteRecoveryArtifact(entry)) continue;
        await this.collect(join(path, entry), `${logical}/${entry}`, files);
      }
      return;
    }
    if (!info.isFile()) return;
    const bytes = sqliteName(basename(path))
      ? await this.sqliteSnapshot(path)
      : await readFile(path);
    const sha256 = digest(bytes);
    await this.storeBlob(sha256, bytes);
    files.push({ path: logical, sha256, size: bytes.byteLength, mode: info.mode & 0o777 });
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
    for (const root of [this.storeRoot, this.sandRoot, this.workspaceRoot, this.home]) {
      await this.repairTemporaryTree(root);
    }
  }

  private async repairTemporaryTree(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      const path = join(root, entry.name);
      if (temporaryName(entry.name)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) await this.repairTemporaryTree(path);
    }
  }
}
