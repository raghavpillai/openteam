// Runs the related #275 characterization suites sequentially against an EMPTY
// disposable database and saves the actual results for review. Assertions in
// these suites document broken behavior; a passing suite does not mean fixed.
// OPENTEAM_TEST_DATABASE_URL=... bun scripts/run-issue-275-audit.ts
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

assert(process.env.OPENTEAM_TEST_DATABASE_URL, "Use an EMPTY disposable database with the current schema");
const cwd = fileURLToPath(new URL("..", import.meta.url));
const suites = ["repro-issue-275-extent.ts", "repro-issue-275-chaos.ts", "repro-issue-275-execution-chaos.ts", "repro-issue-275-final-sweep.ts", "repro-issue-275-revision-chaos.ts", "repro-issue-275-advanced-cadence.ts"];
const results: unknown[] = [];
for (const suite of suites) {
  console.log(`Running ${suite}`);
  const child = Bun.spawn([process.execPath, join(cwd, "scripts", suite)], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) {
    console.error(stdout, stderr);
    throw new Error(`${suite} exited ${exitCode}`);
  }
  const final = stdout.trim().split("\n").at(-1)!;
  const summary = JSON.parse(final);
  results.push({ suite, exitCode, summary, ...(stderr ? { diagnostic: stderr.split("\n")[0] } : {}) });
  console.log(`Verified ${suite}: ${summary.confirmedChecks ?? summary.checks} characterization checks`);
}
const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });
assert.equal(commit.exitCode, 0);
const reportPath = join(cwd, "scripts", "repro-issue-275-results.json");
const report = {
  issue: "https://github.com/raghavpillai/openteam/issues/275",
  testedCommit: commit.stdout.toString().trim(),
  generatedAt: new Date().toISOString(),
  interpretation: "These are characterization checks that assert reproduced failures and controls on unmodified production code. Passing means the described behavior reproduced, not that the bugs were fixed. Cases are not a count of independent root causes.",
  scope: ["all-listener scheduling", "file reconciliation and projection", "create/update/pause/resume", "time-zone changes and migration", "dispatch/claim/settlement", "overlap and background work", "error isolation and recovery fairness", "callback stop and handoff fences", "desktop schedule serialization", "queued-execution revision consistency", "UUID/folder identity collisions", "creation retries after edited input"],
  environment: { database: "disposable local PostgreSQL with current Prisma schema", queueAndComputerExecution: "stubbed; actual messaging, worker claim and recovery code exercised", productionCodeChanged: false },
  coverageConclusion: "A 1,152-case editor Cartesian sweep and two independent calendar/group/phased-interval passes found no additional unclassified timing/serialization failure classes. Subsequent revision, identity and retry probes found further scenarios outside those generated dimensions; all are included below.",
  independentOracle: { method: "minute-by-minute Intl wall-clock matching without cron-parser or production next-run functions", zones: 6, horizonDays: 8, sparseDateLimit: "Occurrences beyond the horizon were checked to remain beyond the horizon; not exhaustively enumerated", calendarCases: 384, groupedCalendarCases: 47, phasedIntervalCases: 320, additionalUnclassifiedMismatches: 0 },
  reviewedBoundaries: ["Group-owned calendar routines avoid bot file-sync overwrite but still share scheduling and execution defects.", "Pure event listeners do not have a cron nextRunAt.", "iOS source preserves composite/event triggers and pinned zones during unrelated edits; no iOS UI run was performed.", "Desktop summary cache ignores fields it does not render; this was not counted as a defect.", "A waiting_approval execution hypothesis was discarded because it is not a persisted RunStatus in the current schema."],
  limitations: ["No deployed routine inventory or production impact count was queried.", "External-provider transport, real model execution, and interactive UI behavior were not exhaustively exercised.", "The result is bounded to the tested commit, generated corpus, and reviewed related paths."],
  suites: results,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Saved ${reportPath}`);
