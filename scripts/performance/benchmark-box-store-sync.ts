import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxStoreSync, type BoxStoreSyncMetrics } from "../../apps/computer/src/box-store-sync";

const AGENT_COUNT = 1_000;
const SQLITE_AGENT_COUNT = 20;
const ITERATIONS = 5;

const percentile = (values: number[], quantile: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
};

const distribution = (values: number[]) => ({
  p50Ms: Number(percentile(values, 0.5).toFixed(3)),
  p95Ms: Number(percentile(values, 0.95).toFixed(3)),
  minMs: Number(Math.min(...values).toFixed(3)),
  maxMs: Number(Math.max(...values).toFixed(3)),
});

const metricDelta = (after: BoxStoreSyncMetrics, before: BoxStoreSyncMetrics) => ({
  directoriesVisited: after.directoriesVisited - before.directoriesVisited,
  sourceFilesInspected: after.sourceFilesInspected - before.sourceFilesInspected,
  sourceFilesRead: after.sourceFilesRead - before.sourceFilesRead,
  sourceBytesRead: after.sourceBytesRead - before.sourceBytesRead,
  contentHashes: after.contentHashes - before.contentHashes,
  signatureReuses: after.signatureReuses - before.signatureReuses,
  sqliteVacuums: after.sqliteVacuums - before.sqliteVacuums,
});

const perIteration = (value: number): number => Number((value / ITERATIONS).toFixed(2));

const legacyRepairWalk = async (roots: readonly string[]) => {
  let directoriesVisited = 0;
  let entriesInspected = 0;
  const visit = async (directory: string): Promise<void> => {
    directoriesVisited += 1;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      entriesInspected += 1;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(join(directory, entry.name));
      }
    }
  };
  for (const root of roots) await visit(root);
  return { directoriesVisited, entriesInspected };
};

const temporary = await mkdtemp(join(tmpdir(), "openbot-box-store-ab-"));
const databases: Database[] = [];
try {
  const home = join(temporary, "home");
  const sandRoot = join(home, "sand-data");
  const workspaceRoot = join(temporary, "workspace");
  const storeRoot = join(temporary, "box-store");
  const piRoot = join(home, ".pi", "agent");
  await Promise.all([
    mkdir(piRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(join(home, "chrome-profile", "Default"), { recursive: true }),
  ]);

  for (let offset = 0; offset < AGENT_COUNT; offset += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, AGENT_COUNT - offset) }, async (_, localIndex) => {
        const index = offset + localIndex;
        const directory = join(sandRoot, "agents", `agent-${index.toString().padStart(4, "0")}`);
        await mkdir(directory, { recursive: true });
        await Promise.all([
          writeFile(
            join(directory, "profile.json"),
            `${JSON.stringify({ name: `Bot ${index}` })}\n`
          ),
          writeFile(
            join(directory, "settings.json"),
            `${JSON.stringify({ notifyOnAgentUpdates: index % 2 === 0 })}\n`
          ),
        ]);
      })
    );
  }

  for (let index = 0; index < SQLITE_AGENT_COUNT; index += 1) {
    const directory = join(sandRoot, "agents", `agent-${index.toString().padStart(4, "0")}`);
    for (const name of ["store.db", "conversation-blobs.db"]) {
      const database = new Database(join(directory, name), { create: true });
      database.exec("PRAGMA journal_mode=WAL; CREATE TABLE payload(value TEXT) STRICT");
      database.query("INSERT INTO payload(value) VALUES (?)").run(`sqlite-${index}-${name}`);
      databases.push(database);
    }
  }

  for (let index = 0; index < 250; index += 1) {
    await writeFile(join(workspaceRoot, `workspace-${index}.txt`), `workspace ${index}\n`);
  }
  for (let index = 0; index < 100; index += 1) {
    await writeFile(join(piRoot, `session-${index}.jsonl`), `{"turn":${index}}\n`);
  }
  await writeFile(join(home, "chrome-profile", "Default", "Preferences"), "{}\n");

  for (const excludedRoot of [
    join(home, "unrelated-cache"),
    join(workspaceRoot, "node_modules"),
    join(workspaceRoot, ".git", "objects"),
  ]) {
    for (let index = 0; index < 100; index += 1) {
      const directory = join(excludedRoot, `bucket-${index}`);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "payload.bin"), "excluded\n");
    }
  }

  const sync = new BoxStoreSync({ storeRoot, home, sandRoot, workspaceRoot });
  await sync.snapshotOut();

  const legacyStartMetrics = sync.diagnostics();
  const legacyLatencies: number[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    await rm(join(storeRoot, ".snapshot-signatures.json"), { force: true });
    const startedAt = performance.now();
    await sync.snapshotOut();
    legacyLatencies.push(performance.now() - startedAt);
  }
  const legacyDelta = metricDelta(sync.diagnostics(), legacyStartMetrics);

  const cachedStartMetrics = sync.diagnostics();
  const cachedLatencies: number[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const startedAt = performance.now();
    await sync.snapshotOut();
    cachedLatencies.push(performance.now() - startedAt);
  }
  const cachedDelta = metricDelta(sync.diagnostics(), cachedStartMetrics);

  const partialStartMetrics = sync.diagnostics();
  const partialLatencies: number[] = [];
  const partialAgentId = "agent-0999";
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    await writeFile(
      join(sandRoot, "agents", partialAgentId, "profile.json"),
      `${JSON.stringify({ name: `Changed ${iteration}` })}\n`
    );
    const startedAt = performance.now();
    await sync.snapshotOut({ agentIds: [partialAgentId] });
    partialLatencies.push(performance.now() - startedAt);
  }
  const partialDelta = metricDelta(sync.diagnostics(), partialStartMetrics);

  const legacyRepairStartedAt = performance.now();
  const legacyRepair = await legacyRepairWalk([storeRoot, sandRoot, workspaceRoot, home]);
  const legacyRepairMs = performance.now() - legacyRepairStartedAt;
  const startupSync = new BoxStoreSync({ storeRoot, home, sandRoot, workspaceRoot });
  const optimizedRepairStartedAt = performance.now();
  await startupSync.start();
  const optimizedRepairMs = performance.now() - optimizedRepairStartedAt;
  const optimizedRepair = startupSync.diagnostics();

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runtime: `Bun ${Bun.version}`,
        fixture: {
          agents: AGENT_COUNT,
          sqliteDatabasesWithWal: SQLITE_AGENT_COUNT * 2,
          includedFiles: AGENT_COUNT * 2 + SQLITE_AGENT_COUNT * 2 + 250 + 100 + 1,
          excludedFiles: 300,
          iterations: ITERATIONS,
        },
        unchangedFullSnapshot: {
          before: {
            behavior: "read and SHA-256 every file; VACUUM every active SQLite database",
            latency: distribution(legacyLatencies),
            operationsPerRun: Object.fromEntries(
              Object.entries(legacyDelta).map(([key, value]) => [key, perIteration(value)])
            ),
          },
          after: {
            behavior:
              "walk/stat all sources; reuse manifest hashes and SQLite snapshots by safe signature",
            latency: distribution(cachedLatencies),
            operationsPerRun: Object.fromEntries(
              Object.entries(cachedDelta).map(([key, value]) => [key, perIteration(value)])
            ),
          },
        },
        oneDirtyAgentSnapshot: {
          after: {
            behavior: "walk only the dirty agent subtree and reuse clean manifest roots",
            latency: distribution(partialLatencies),
            operationsPerRun: Object.fromEntries(
              Object.entries(partialDelta).map(([key, value]) => [key, perIteration(value)])
            ),
          },
        },
        startupTemporaryRepair: {
          before: {
            behavior: "recursive store+sand+workspace+HOME traversal with sand-data visited twice",
            latencyMs: Number(legacyRepairMs.toFixed(3)),
            ...legacyRepair,
          },
          after: {
            behavior:
              "deduplicated source roots; shallow store/blob repair; build/cache exclusions",
            latencyMs: Number(optimizedRepairMs.toFixed(3)),
            repairRoots: optimizedRepair.repairRoots,
            directoriesVisited: optimizedRepair.repairDirectoriesVisited,
            entriesInspected: optimizedRepair.repairEntriesInspected,
          },
        },
        scheduledBurst: {
          before: "one serialized snapshot appended per request after the debounce fires",
          after:
            "one active snapshot plus one merged pending rerun (verified by focused 101-request test)",
        },
      },
      null,
      2
    )
  );
} finally {
  for (const database of databases) database.close(false);
  await rm(temporary, { recursive: true, force: true });
}
