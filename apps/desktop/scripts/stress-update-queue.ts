import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runChaosSeed } from "../test/fixtures/update-queue-chaos-model";

const scenarios = Number(process.env.OPENTEAM_CHAOS_SEEDS ?? 5000);
const offset = Number(process.env.OPENTEAM_CHAOS_SEED_OFFSET ?? 0);
if (
  !Number.isSafeInteger(scenarios) ||
  scenarios < 1 ||
  scenarios > 100_000 ||
  !Number.isSafeInteger(offset) ||
  offset < 0 ||
  !Number.isSafeInteger(offset + scenarios)
)
  throw new Error("Choose 1–100,000 seeds and a nonnegative integer seed offset");
const started = performance.now();
const faults: Record<string, number> = {};
const failures: Array<{ seed: number; message: string }> = [];
const totals = {
  actions: 0,
  polls: 0,
  hostSubmissions: 0,
  nativeDownloads: 0,
  checkpointReplays: 0,
};
for (let index = 0; index < scenarios; index++) {
  const seed = offset + index;
  try {
    const value = await runChaosSeed(seed, index === 0 ? 10_000 : 64);
    faults[value.fault] = (faults[value.fault] ?? 0) + 1;
    totals.actions += value.actions;
    totals.polls += value.serverReads;
    totals.hostSubmissions += value.serverPosts;
    totals.nativeDownloads += value.downloads;
    totals.checkpointReplays += value.checkpointReplays;
  } catch (error) {
    failures.push({ seed, message: error instanceof Error ? error.message : String(error) });
  }
}
const report = {
  simulated: true,
  seedRange: [offset, offset + scenarios - 1],
  scenarios,
  passed: scenarios - failures.length,
  failed: failures.length,
  wallTimeMs: Math.round(performance.now() - started),
  faults,
  totals,
  failures: failures.slice(0, 25),
};
const output = resolve(import.meta.dirname, "../../../output/update-queue-chaos");
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "stress-results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
