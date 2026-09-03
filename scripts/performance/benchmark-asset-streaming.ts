import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDataStore, AssetStore } from "../../packages/messaging/src";

const WORKLOAD_BYTES = 48 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const ITERATIONS = 3;
const scenarios = ["raw-before", "raw-after", "materialize-before", "materialize-after"] as const;
type Scenario = (typeof scenarios)[number];

interface MemorySample {
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

const memory = (): MemorySample => {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    arrayBuffers: usage.arrayBuffers,
  };
};

const writeFully = async (
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array
): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("benchmark write made no progress");
    offset += bytesWritten;
  }
};

const prepareSource = async (root: string): Promise<{ source: string; assetId: string }> => {
  const source = join(root, "source.mp4");
  const handle = await open(source, "wx", 0o600);
  const chunk = Buffer.alloc(CHUNK_BYTES, 0x5a);
  const hash = createHash("sha256");
  try {
    for (let written = 0; written < WORKLOAD_BYTES; written += CHUNK_BYTES) {
      const bytes = chunk.subarray(0, Math.min(CHUNK_BYTES, WORKLOAD_BYTES - written));
      hash.update(bytes);
      await writeFully(handle, bytes);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { source, assetId: hash.digest("hex") };
};

const measured = async <T>(
  action: (sample: () => void) => Promise<T>
): Promise<
  T & {
    elapsedMs: number;
    peakRssDeltaBytes: number;
    peakHeapDeltaBytes: number;
    peakArrayBufferDeltaBytes: number;
  }
> => {
  Bun.gc(true);
  await Bun.sleep(20);
  Bun.gc(true);
  const baseline = memory();
  let peak = { ...baseline };
  const sample = () => {
    const current = memory();
    peak = {
      rss: Math.max(peak.rss, current.rss),
      heapUsed: Math.max(peak.heapUsed, current.heapUsed),
      arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers),
    };
  };
  const timer = setInterval(sample, 1);
  const startedAt = performance.now();
  try {
    const result = await action(sample);
    sample();
    return {
      ...result,
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      peakRssDeltaBytes: Math.max(0, peak.rss - baseline.rss),
      peakHeapDeltaBytes: Math.max(0, peak.heapUsed - baseline.heapUsed),
      peakArrayBufferDeltaBytes: Math.max(0, peak.arrayBuffers - baseline.arrayBuffers),
    };
  } finally {
    clearInterval(timer);
  }
};

const legacyWholeBufferCopy = async (
  source: string,
  destination: string,
  expectedAssetId: string,
  sample: () => void
): Promise<void> => {
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  for await (const chunk of createReadStream(source, { highWaterMark: CHUNK_BYTES })) {
    chunks.push(chunk);
    byteSize += chunk.byteLength;
    sample();
  }
  const bytes = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  sample();
  if (createHash("sha256").update(bytes).digest("hex") !== expectedAssetId) {
    throw new Error("legacy benchmark digest mismatch");
  }
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  sample();
};

const runScenario = async (scenario: Scenario) => {
  const root = await mkdtemp(join(tmpdir(), `openteam-asset-benchmark-${scenario}-`));
  try {
    const { source, assetId } = await prepareSource(root);
    if (scenario === "raw-before") {
      return await measured(async (sample) => {
        await legacyWholeBufferCopy(source, join(root, "legacy-upload.blob"), assetId, sample);
        return { transactionMs: null };
      });
    }
    if (scenario === "raw-after") {
      const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
      return await measured(async () => {
        const ref = await store.ingestStream({
          fileName: "benchmark.mp4",
          mimeType: "video/mp4",
          stream: createReadStream(source, { highWaterMark: CHUNK_BYTES }),
        });
        if (ref.assetId !== assetId) throw new Error("streaming benchmark digest mismatch");
        return { transactionMs: null };
      });
    }
    if (scenario === "materialize-before") {
      await mkdir(join(root, "legacy-agent", "attachments"), { recursive: true });
      return await measured(async (sample) => {
        const startedAt = performance.now();
        await legacyWholeBufferCopy(
          source,
          join(root, "legacy-agent", "attachments", `${assetId}.mp4`),
          assetId,
          sample
        );
        return { transactionMs: Number((performance.now() - startedAt).toFixed(3)) };
      });
    }

    const dataRoot = join(root, "agent-data");
    const assetRoot = join(root, "assets");
    await mkdir(assetRoot, { recursive: true });
    const assetPath = join(assetRoot, `${assetId}.blob`);
    const assetHandle = await open(assetPath, "wx", 0o600);
    const sourceHandle = await open(source, "r");
    try {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = 0;
      while (position < WORKLOAD_BYTES) {
        const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.byteLength, position);
        if (bytesRead === 0) throw new Error("benchmark source ended early");
        await writeFully(assetHandle, chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
      await assetHandle.sync();
    } finally {
      await Promise.all([assetHandle.close(), sourceHandle.close()]);
    }
    let transactionMs = 0;
    const prisma = {
      bot: { count: async () => 1 },
      $transaction: async <T>(action: (tx: unknown) => Promise<T>): Promise<T> => {
        const startedAt = performance.now();
        const result = await action({
          $executeRaw: async () => 1,
          bot: { count: async () => 1 },
        });
        transactionMs = performance.now() - startedAt;
        return result;
      },
    };
    const store = new AgentDataStore(prisma as never, {
      root: dataRoot,
      assetRoot,
      workspaceRoot: join(root, "workspace"),
    });
    return await measured(async () => {
      const paths = await store.materializeAttachments("benchmark-bot", "benchmark-message", [
        {
          assetId,
          fileName: "benchmark.mp4",
          mimeType: "video/mp4",
          byteSize: WORKLOAD_BYTES,
          kind: "video",
        },
      ]);
      if (paths.length !== 1) throw new Error("streaming materialization did not complete");
      return { transactionMs: Number(transactionMs.toFixed(3)) };
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

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

const main = async () => {
  const requested = process.argv.find((value) => value.startsWith("--scenario="))?.slice(11) as
    | Scenario
    | undefined;
  if (requested) {
    if (!scenarios.includes(requested)) throw new Error(`Unknown scenario ${requested}`);
    console.log(JSON.stringify(await runScenario(requested)));
    return;
  }

  const runs = new Map<Scenario, Array<Awaited<ReturnType<typeof runScenario>>>>();
  for (const scenario of scenarios) {
    const scenarioRuns: Array<Awaited<ReturnType<typeof runScenario>>> = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const child = Bun.spawn([process.execPath, import.meta.path, `--scenario=${scenario}`], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`${scenario} failed: ${stderr || stdout}`);
      scenarioRuns.push(JSON.parse(stdout) as Awaited<ReturnType<typeof runScenario>>);
    }
    runs.set(scenario, scenarioRuns);
  }

  const summarize = (scenario: Scenario) => {
    const values = runs.get(scenario) ?? [];
    const transactionValues = values.flatMap(({ transactionMs }) =>
      transactionMs === null ? [] : [transactionMs]
    );
    return {
      latency: distribution(values.map(({ elapsedMs }) => elapsedMs)),
      ...(transactionValues.length > 0
        ? { transactionLatency: distribution(transactionValues) }
        : {}),
      peakMemory: {
        arrayBuffersBytes: Math.max(
          ...values.map(({ peakArrayBufferDeltaBytes }) => peakArrayBufferDeltaBytes)
        ),
        rssBytes: Math.max(...values.map(({ peakRssDeltaBytes }) => peakRssDeltaBytes)),
        heapBytes: Math.max(...values.map(({ peakHeapDeltaBytes }) => peakHeapDeltaBytes)),
      },
    };
  };

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        workload: {
          bytes: WORKLOAD_BYTES,
          chunkBytes: CHUNK_BYTES,
          iterations: ITERATIONS,
        },
        methodology: {
          isolation:
            "Each iteration ran in a fresh Bun subprocess after forced GC; source creation was outside the measured window.",
          memory:
            "Process RSS, heap, and ArrayBuffer usage were sampled every 1 ms; the table reports the maximum delta from the post-GC baseline.",
          before:
            "The legacy path retained every source chunk, allocated one contiguous payload, then hashed and wrote it while attachment mutation timing remained open.",
          after:
            "The streaming path incrementally hashed and wrote 1 MiB chunks; attachment mutation timing covers only advisory locks, bot revalidation, atomic rename, and directory fsync.",
        },
        rawUpload: {
          before: summarize("raw-before"),
          after: summarize("raw-after"),
          ioPerRun: {
            before: { sourceReadBytes: WORKLOAD_BYTES, blobWriteBytes: WORKLOAD_BYTES },
            after: {
              sourceReadBytes: WORKLOAD_BYTES,
              blobWriteBytes: WORKLOAD_BYTES,
              classificationReadBytes: 0,
              boundedInMemoryClassificationProbeBytes: 8_192,
            },
          },
        },
        materializeAttachments: {
          before: summarize("materialize-before"),
          after: summarize("materialize-after"),
          ioPerRun: {
            before: { assetReadBytes: WORKLOAD_BYTES, attachmentWriteBytes: WORKLOAD_BYTES },
            after: { assetReadBytes: WORKLOAD_BYTES, attachmentWriteBytes: WORKLOAD_BYTES },
          },
        },
      },
      null,
      2
    )
  );
};

await main();
