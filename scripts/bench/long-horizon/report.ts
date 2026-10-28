import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditSupport } from "./audit";

export function distribution(values: Array<number | null | undefined>) {
  const sorted = values.filter((n): n is number => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return { observed: 0, median: null, p90: null, max: null };
  const mid = Math.floor(sorted.length / 2);
  return { observed: sorted.length, median: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    p90: sorted[Math.ceil(sorted.length * .9) - 1]!, max: sorted.at(-1)! };
}

export function summarizeTrials(rows: any[]) {
  const valid = rows.filter(r => !r.infrastructureInvalid);
  const finished = valid.filter(r => r.audit.fullyFinished);
  return {
    observedAttempts: rows.length, infrastructureInvalid: rows.filter(r => r.infrastructureInvalid).map(r => r.id),
    validTrials: valid.length, providerOutcomePassed: valid.filter(r => r.audit.providerOutcome).length,
    fullyFinished: finished.length,
    unfinishedReviews: valid.reduce((n, r) => n + r.audit.unfinishedReviews.length, 0),
    abandonedReviews: valid.reduce((n, r) => n + r.audit.abandonedReviews.length, 0),
    reportedWithin90Sec: valid.filter(r => r.score.timelyReport && r.audit.fullyFinished).length,
    reportLatencySec: distribution(finished.map(r => r.score.reportAfterResolutionSec)),
    workerFinishAfterProviderSec: distribution(finished.map(r => r.workerFinishAfterProviderSec)),
    reportRelativeToWorkerFinishSec: distribution(finished.map(r => r.reportRelativeToWorkerFinishSec)),
    criticalQuestions: valid.reduce((n, r) => n + (r.score.criticalQuestions ?? 0), 0),
    timelyCriticalAnswers: valid.reduce((n, r) => n + (r.score.answeredCriticalQuestions ?? 0), 0),
    idleClosures: valid.reduce((n, r) => n + (r.score.idleClosed ?? 0), 0),
    browserCalls: distribution(valid.map(r => r.usage?.browserCalls)),
    estimatedUsdPerObservedTrial: distribution(valid.map(r => r.usage?.estimatedUsd)),
    semanticClaimsReviewStillRequired: valid.filter(r => !r.claimsAudit?.reviewed).map(r => r.id),
    interpretation: "Exploratory fixed-stack trials. Missing reports are excluded from latency distributions, not treated as fast completions. Action gates and semantic claims are separate; no production reliability or causal superiority estimate.",
  };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Usage: bun report.ts <support-bench/data/runs>");
  const cohort = join(root, "long-horizon-round3");
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const optional = (path: string) => existsSync(path) ? read(path) : null;
  const arms: Record<string, unknown> = {};
  for (const arm of ["base", "candidate"]) {
    const pipeline = optional(join(cohort, `${arm}-pipeline.json`));
    if (!pipeline) continue;
    const rows: any[] = [];
    for (const task of pipeline.tasks) {
      for (const id of [...(task.invalidAttempts ?? []), task.id]) {
        const folder = join(root, id), result = optional(join(folder, "result.json"));
        if (!result) {
          if (optional(join(folder, "provenance-audit.json"))?.validForPrimaryComparison === false)
            rows.push({ id, scenario: task.scenario, score: {}, audit: null, infrastructureInvalid: true });
          continue;
        }
        const score = read(join(folder, "score.json")), subs = optional(join(folder, "subagents-at-end.json")) ?? [];
        const completionTimes = subs.map((s: any) => s.completedAt ? Date.parse(s.completedAt.endsWith("Z") ? s.completedAt : s.completedAt + "Z") : 0).filter(Number.isFinite);
        const workerDoneAt = completionTimes.length ? Math.max(...completionTimes) : null;
        rows.push({ id, scenario: task.scenario, score, audit: auditSupport(result),
          infrastructureInvalid: optional(join(folder, "provenance-audit.json"))?.validForPrimaryComparison === false || score.infrastructureFailure,
          workerFinishAfterProviderSec: workerDoneAt && score.completedAt ? (workerDoneAt - score.completedAt) / 1000 : null,
          reportRelativeToWorkerFinishSec: workerDoneAt && score.reportAt ? (score.reportAt - workerDoneAt) / 1000 : null,
          timingLimit: "Signed report-to-final-worker timing is not checkpoint-to-parent relay latency. A negative value can reflect progress before worker completion. Match milestone evidence manually before attributing detection versus relay delay.",
          usage: optional(join(folder, "usage.json")), claimsAudit: optional(join(folder, "claims-audit.json")) });
      }
    }
    arms[arm] = { completedAt: pipeline.completedAt ?? null, summary: summarizeTrials(rows),
      byScenario: Object.fromEntries(["S1", "S2N"].map(s => [s, summarizeTrials(rows.filter(r => r.scenario === s))])), rows };
  }
  const report = { generatedAt: new Date().toISOString(), arms };
  writeFileSync(join(cohort, "primary-final-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(Object.fromEntries(Object.entries(arms).map(([arm, value]: any) => [arm, value.summary]))));
}
