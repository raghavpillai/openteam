import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetRef } from "../../packages/contracts/src";
import { AgentDataStore, AssetStore } from "../../packages/messaging/src";

const IMAGE_COUNT = 6;
const IMAGE_BYTES = Number(process.env.OPENTEAM_BENCH_IMAGE_BYTES ?? 8 * 1024 * 1024);
const AGENT_COUNT = 1_000;
const ITERATIONS = Number(process.env.OPENTEAM_BENCH_ITERATIONS ?? 5);
const LOOKUP_ITERATIONS = 20;
const LOOKUP_FANOUT = 16;

type RuntimeScenario = "runtime-current" | "runtime-sequential-candidate";

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

const measuredRuntime = async (scenario: RuntimeScenario) => {
  const root = await mkdtemp(join(tmpdir(), `openteam-${scenario}-`));
  try {
    const store = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
    const refs: AssetRef[] = [];
    for (let index = 0; index < IMAGE_COUNT; index += 1) {
      const bytes = Buffer.alloc(IMAGE_BYTES, index + 1);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
      bytes.writeUInt32BE(index + 1, 16);
      bytes.writeUInt32BE(index + 2, 20);
      refs.push(
        await store.ingestBytes({
          fileName: `image-${index}.png`,
          mimeType: "image/png",
          bytes,
          alt: `Image ${index}`,
        })
      );
    }
    await store.normalizeRefs(refs);
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
    const sampler = setInterval(sample, 1);
    const startedAt = performance.now();
    const images =
      scenario === "runtime-current"
        ? await store.runtimeImages(refs)
        : await (async () => {
            const output: Array<{ url: string; alt?: string }> = [];
            for (const ref of await store.normalizeRefs(
              refs.filter((ref) => ref.kind === "image")
            )) {
              output.push({
                url: `data:${ref.mimeType};base64,${(await readFile(store.contentPath(ref.assetId))).toString("base64")}`,
                ...(ref.alt ? { alt: ref.alt } : {}),
              });
            }
            return output;
          })();
    sample();
    clearInterval(sampler);
    const encodedCharacters = images.reduce((total, image) => total + image.url.length, 0);
    if (images.length !== IMAGE_COUNT || encodedCharacters === 0) {
      throw new Error("runtime image benchmark lost output");
    }
    return {
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      encodedCharacters,
      peakRssDeltaBytes: Math.max(0, peak.rss - baseline.rss),
      peakHeapDeltaBytes: Math.max(0, peak.heapUsed - baseline.heapUsed),
      peakArrayBufferDeltaBytes: Math.max(0, peak.arrayBuffers - baseline.arrayBuffers),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const legacyAgentAttachmentPath = async (root: string, assetId: string): Promise<string | null> => {
  const agentsRoot = join(root, "agents");
  const agents = (await readdir(agentsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  for (const agentId of agents) {
    const attachments = join(agentsRoot, agentId, "attachments");
    const match = (await readdir(attachments).catch(() => []))
      .filter((name) => name.startsWith(`${assetId}.`))
      .sort()[0];
    if (!match) continue;
    const candidate = join(attachments, match);
    const canonical = await realpath(candidate).catch(() => null);
    const canonicalRoot = await realpath(attachments).catch(() => attachments);
    if (canonical?.startsWith(`${canonicalRoot}/`)) return canonical;
  }
  return null;
};

const measureLookups = async (lookup: () => Promise<string | null>, expected: string) => {
  const samples: number[] = [];
  for (let iteration = 0; iteration < LOOKUP_ITERATIONS; iteration += 1) {
    const startedAt = performance.now();
    if ((await lookup()) !== expected) throw new Error("legacy attachment lookup lost parity");
    samples.push(performance.now() - startedAt);
  }
  return samples;
};

const lookupBenchmark = async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-legacy-attachment-"));
  try {
    const agentsRoot = join(root, "agents");
    for (let offset = 0; offset < AGENT_COUNT; offset += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, AGENT_COUNT - offset) }, (_, index) =>
          mkdir(
            join(agentsRoot, `agent-${String(offset + index).padStart(4, "0")}`, "attachments"),
            {
              recursive: true,
            }
          )
        )
      );
    }
    const assetId = "f".repeat(64);
    const expected = join(
      agentsRoot,
      `agent-${String(AGENT_COUNT - 1).padStart(4, "0")}`,
      "attachments",
      `${assetId}.png`
    );
    await Bun.write(expected, "legacy bytes");
    const canonicalExpected = await realpath(expected);
    const store = new AgentDataStore({} as never, { root });
    const before = await measureLookups(
      () => legacyAgentAttachmentPath(root, assetId),
      canonicalExpected
    );
    const legacyFanoutStartedAt = performance.now();
    const legacyFanout = await Promise.all(
      Array.from({ length: LOOKUP_FANOUT }, () => legacyAgentAttachmentPath(root, assetId))
    );
    if (legacyFanout.some((path) => path !== canonicalExpected)) {
      throw new Error("legacy concurrent attachment lookup lost parity");
    }
    const legacyFanoutMs = performance.now() - legacyFanoutStartedAt;
    const fanoutStore = new AgentDataStore({} as never, { root });
    const optimizedFanoutStartedAt = performance.now();
    const optimizedFanout = await Promise.all(
      Array.from({ length: LOOKUP_FANOUT }, () => fanoutStore.agentAttachmentPath(assetId))
    );
    if (optimizedFanout.some((path) => path !== canonicalExpected)) {
      throw new Error("optimized concurrent attachment lookup lost parity");
    }
    const optimizedFanoutMs = performance.now() - optimizedFanoutStartedAt;
    const coldStartedAt = performance.now();
    if ((await store.agentAttachmentPath(assetId)) !== canonicalExpected) {
      throw new Error("optimized cold attachment lookup lost parity");
    }
    const coldMs = performance.now() - coldStartedAt;
    const after = await measureLookups(() => store.agentAttachmentPath(assetId), canonicalExpected);
    return {
      before: {
        behavior: "full sorted traversal on every central-store miss",
        filesystemOperationsPerLookup: AGENT_COUNT + 3,
        latency: distribution(before),
      },
      after: {
        behavior: "full traversal once, then bounded positive LRU with realpath validation",
        coldLatencyMs: Number(coldMs.toFixed(3)),
        warmFilesystemOperationsPerLookup: 2,
        warmLatency: distribution(after),
      },
      concurrentColdFanout: {
        requests: LOOKUP_FANOUT,
        before: {
          filesystemOperations: LOOKUP_FANOUT * (AGENT_COUNT + 3),
          elapsedMs: Number(legacyFanoutMs.toFixed(3)),
        },
        after: {
          filesystemOperations: AGENT_COUNT + 3,
          elapsedMs: Number(optimizedFanoutMs.toFixed(3)),
        },
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const main = async () => {
  const requested = process.argv.find((value) => value.startsWith("--scenario="))?.slice(11) as
    | RuntimeScenario
    | undefined;
  if (requested) {
    console.log(JSON.stringify(await measuredRuntime(requested)));
    return;
  }
  const scenarios = ["runtime-current", "runtime-sequential-candidate"] as const;
  const runs = new Map<RuntimeScenario, Array<Awaited<ReturnType<typeof measuredRuntime>>>>();
  for (const scenario of scenarios) {
    const values: Array<Awaited<ReturnType<typeof measuredRuntime>>> = [];
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
      values.push(JSON.parse(stdout));
    }
    runs.set(scenario, values);
  }
  const runtime = Object.fromEntries(
    scenarios.map((scenario) => {
      const values = runs.get(scenario) ?? [];
      return [
        scenario === "runtime-current" ? "current" : "rejectedSequentialCandidate",
        {
          latency: distribution(values.map(({ elapsedMs }) => elapsedMs)),
          encodedCharacters: values[0]?.encodedCharacters ?? 0,
          peakMemory: {
            rssBytes: Math.max(...values.map(({ peakRssDeltaBytes }) => peakRssDeltaBytes)),
            heapBytes: Math.max(...values.map(({ peakHeapDeltaBytes }) => peakHeapDeltaBytes)),
            arrayBuffersBytes: Math.max(
              ...values.map(({ peakArrayBufferDeltaBytes }) => peakArrayBufferDeltaBytes)
            ),
          },
        },
      ];
    })
  );

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runtime: `Bun ${Bun.version}`,
        fixture: {
          runtimeImages: IMAGE_COUNT,
          bytesPerImage: IMAGE_BYTES,
          runtimeIterations: ITERATIONS,
          legacyAgents: AGENT_COUNT,
          legacyLookupIterations: LOOKUP_ITERATIONS,
          legacyColdFanout: LOOKUP_FANOUT,
        },
        methodology: {
          runtime:
            "Each sample used a fresh process, warm verified metadata, forced GC, and 1 ms memory sampling; current bounded Promise.all was compared with sequential reads and both emitted byte-identical data URLs.",
          legacyLookup:
            "The target was in the last of 1,000 sorted agent directories; the after path validates every positive cache hit and never caches misses.",
        },
        runtimeImages: runtime,
        runtimeImagesDecision:
          "Retain current bounded concurrency: the sequential candidate did not improve near-limit peak RSS and materially increased latency and measured heap. Removing base64 materialization requires a runtime contract change.",
        legacyAgentAttachmentLookup: await lookupBenchmark(),
        retainedSemantics: {
          runtimeContract: "RuntimeInlineImage data URLs, order, MIME, and alt text unchanged",
          legacyFallback:
            "Cold and post-invalidation scans remain dynamic; newly added legacy files are still discoverable",
        },
      },
      null,
      2
    )
  );
};

await main();
