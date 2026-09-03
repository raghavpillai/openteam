import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokAgentStore } from "../../apps/computer/src/grok-agent-store";
import { AUTOMATION_RECONCILE_BATCH_SIZE } from "../../apps/worker/src/worker";
import { AgentDataStore } from "../../packages/messaging/src/agent-data";

const BOT_COUNT = 1_000;
const ITERATIONS = 12;
const uuidAt = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

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

const legacyDirectoryScan = async (agentsRoot: string): Promise<number> => {
  let inspected = 0;
  for (const entry of await readdir(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    inspected += 1;
    const directory = join(agentsRoot, entry.name);
    await Promise.all([
      stat(directory),
      stat(join(directory, "store.db")).catch(() => null),
      readFile(join(directory, "group.json"), "utf8").catch(() => null),
      readFile(join(directory, "profile.json"), "utf8").catch(() => null),
      readFile(join(directory, "settings.json"), "utf8").catch(() => null),
      stat(join(directory, "memory", "profile.md")).catch(() => null),
      readdir(directory).catch(() => []),
    ]);
  }
  return inspected;
};

const measure = async (work: () => Promise<void>): Promise<number[]> => {
  const samples: number[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const startedAt = performance.now();
    await work();
    samples.push(performance.now() - startedAt);
  }
  return samples;
};

const temporary = await mkdtemp(join(tmpdir(), "openteam-periodic-reconcile-ab-"));
try {
  const agentsRoot = join(temporary, "agents");
  await mkdir(agentsRoot, { recursive: true });
  const ids = Array.from({ length: BOT_COUNT }, (_, index) => uuidAt(index));
  for (let offset = 0; offset < ids.length; offset += 50) {
    await Promise.all(
      ids.slice(offset, offset + 50).map(async (id, index) => {
        const directory = join(agentsRoot, id);
        await mkdir(directory, { recursive: true });
        await Promise.all([
          writeFile(join(directory, "profile.json"), `{"name":"Bot ${offset + index}"}\n`),
          writeFile(join(directory, "settings.json"), '{"notifyOnAgentUpdates":true}\n'),
        ]);
      })
    );
  }

  await legacyDirectoryScan(agentsRoot);
  const legacyDirectorySamples = await measure(async () => {
    await legacyDirectoryScan(agentsRoot);
  });

  const grokStore = new GrokAgentStore(temporary);
  await grokStore.agentDirectorySnapshot({ forceRefresh: true });
  const metricsBeforeCachedPolls = grokStore.agentDirectoryDiscoveryMetrics();
  const cachedDirectorySamples = await measure(async () => {
    await grokStore.agentDirectorySnapshot();
  });
  const metricsAfterCachedPolls = grokStore.agentDirectoryDiscoveryMetrics();

  let transactionCount = 0;
  const prisma = {
    bot: {
      findMany: async (input: { where: { id?: { gt?: string } }; take?: number }) => {
        const after = input.where.id?.gt;
        const matches = ids.filter((id) => !after || id > after);
        return matches.slice(0, input.take ?? matches.length).map((id) => ({ id }));
      },
    },
    $transaction: async (work: (tx: { $executeRaw: () => Promise<number> }) => Promise<void>) => {
      transactionCount += 1;
      await work({ $executeRaw: async () => 0 });
    },
  };
  const agentData = new AgentDataStore(prisma as never, { root: temporary });
  Object.defineProperty(agentData, "reconcileAutomations", {
    value: async () => undefined,
  });
  await agentData.reconcileAllAutomationFiles();
  const legacyAutomationSamples = await measure(async () => {
    await agentData.reconcileAllAutomationFiles();
  });
  const legacyAutomationTransactions = transactionCount / (ITERATIONS + 1);
  transactionCount = 0;
  const boundedAutomationSamples = await measure(async () => {
    await agentData.reconcileAutomationFilesBatch(null, AUTOMATION_RECONCILE_BATCH_SIZE);
  });
  const boundedAutomationTransactions = transactionCount / ITERATIONS;

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runtime: `Bun ${Bun.version}`,
        fixture: { activeBots: BOT_COUNT, iterations: ITERATIONS },
        agentStoreDiscovery: {
          before: {
            behavior: "full directory stat/read scan on every five-second poll",
            directoriesInspectedPerPoll: BOT_COUNT,
            filesystemOperationsPerPoll: BOT_COUNT * 7 + 1,
            latency: distribution(legacyDirectorySamples),
          },
          after: {
            behavior: "root-stamp check plus conditional ETag on an unchanged roster",
            directoriesInspectedPerPoll:
              (metricsAfterCachedPolls.directoriesInspected -
                metricsBeforeCachedPolls.directoriesInspected) /
              ITERATIONS,
            cacheHits: metricsAfterCachedPolls.cacheHits - metricsBeforeCachedPolls.cacheHits,
            latency: distribution(cachedDirectorySamples),
          },
        },
        automationSafetySweep: {
          before: {
            behavior: "all active bots on every one-second dispatch pass",
            transactionsPerTick: legacyAutomationTransactions,
            latency: distribution(legacyAutomationSamples),
          },
          after: {
            behavior: "watcher/startup fast paths plus bounded round-robin recovery page",
            transactionsPerTick: boundedAutomationTransactions,
            ticksPerFullFallbackCycle: Math.ceil(BOT_COUNT / AUTOMATION_RECONCILE_BATCH_SIZE),
            latency: distribution(boundedAutomationSamples),
          },
        },
      },
      null,
      2
    )
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
