import { expect, test } from "bun:test";
import { distribution, hourTrialId, summarizeTrials } from "./report";

test("hour evidence follows its recorded cohort rather than reading a previous cohort", () => {
  expect(hourTrialId({ hour: { id: "fresh-candidate-hour-1" } }, "candidate"))
    .toBe("fresh-candidate-hour-1");
  expect(hourTrialId(undefined, "grok")).toBe("runtime-grok-H1-1");
  expect(hourTrialId({ hour: null }, "candidate", { candidate: "fresh-candidate-hour-1" }))
    .toBe("fresh-candidate-hour-1");
  expect(() => hourTrialId({ hour: { id: "old-hour" } }, "grok", { grok: "fresh-hour" })).toThrow();
  expect(() => hourTrialId({ hour: { id: "../another-cohort/result" } }, "grok")).toThrow();
});

test("missing timing and invalid infrastructure attempts cannot inflate completion or speed", () => {
  const row = { id: "valid", audit: { fullyFinished: true, providerOutcome: true, unfinishedReviews: [], abandonedReviews: [] }, score: { reportAfterResolutionSec: 60, timelyReport: true } };
  const failed = { ...row, id: "failed", audit: { ...row.audit, fullyFinished: false }, score: { reportAfterResolutionSec: null } };
  const invalid = { ...row, id: "disk-pressure", infrastructureInvalid: true, score: { reportAfterResolutionSec: 1, timelyReport: true } };
  expect(summarizeTrials([row, failed, invalid])).toMatchObject({ validTrials: 2, fullyFinished: 1,
    infrastructureInvalid: ["disk-pressure"], reportedWithin90Sec: 1,
    reportLatencySec: { observed: 1, median: 60, p90: 60, max: 60 } });
  expect(distribution([5, 9, null, 1, 3])).toEqual({ observed: 4, median: 4, p90: 9, max: 9 });
});

test("cost per completed task uses reviewed outcomes and includes failed-attempt cost", () => {
  const row = { id: "delivered", audit: { providerOutcome: true, explicitApprovalBeforeSend: true,
    fullyFinished: false, unfinishedReviews: [], abandonedReviews: [] }, score: {}, usage: { estimatedUsd: 1 },
    claimsAudit: { reviewed: true, passed: true, finalDeliveryVerified: true } };
  expect(summarizeTrials([row, { ...row, id: "failed", claimsAudit: { reviewed: true, passed: false } }]))
    .toMatchObject({ reviewedHardGatesPassed: 1, estimatedUsdPerFinishedTaskIncludingObservedFailures: 2 });
  expect(summarizeTrials([{ ...row, usage: null }]).estimatedUsdPerFinishedTaskIncludingObservedFailures).toBeNull();
});

test("comparison exclusions retain reviewed false claims as diagnostic failures", () => {
  const excluded = { id: "no-account-access", infrastructureInvalid: true, audit: null,
    claimsAudit: { reviewed: true, passed: false, finalDeliveryVerified: false } };
  const notReviewed = { id: "interrupted-collection", infrastructureInvalid: true, audit: null };
  expect(summarizeTrials([excluded, notReviewed])).toMatchObject({
    observedAttempts: 2, validTrials: 0, reviewedHardGatesPassed: 0,
    reviewedClaimsFailed: [], excludedAttemptClaimsFailures: ["no-account-access"],
    infrastructureInvalid: ["no-account-access", "interrupted-collection"],
  });
});

test("a reviewed final follow-up can establish delivery without matching a refund phrase twice", () => {
  const row = { id: "different-wording", audit: { providerOutcome: true, explicitApprovalBeforeSend: true,
    fullyFinished: false, unfinishedReviews: [], abandonedReviews: [] }, score: {},
    claimsAudit: { reviewed: true, passed: true, finalDeliveryVerified: true } };
  expect(summarizeTrials([row])).toMatchObject({ fullyFinished: 0, reviewedHardGatesPassed: 1 });
  expect(summarizeTrials([{ ...row, audit: { ...row.audit, unfinishedReviews: [{ id: "pending" }] } }]))
    .toMatchObject({ reviewedHardGatesPassed: 0 });
});

test("an early refund milestone cannot count as a timely reviewed full-completion report", () => {
  const row = { id: "milestone-before-verification", audit: { providerOutcome: true,
    explicitApprovalBeforeSend: true, fullyFinished: true, unfinishedReviews: [], abandonedReviews: [] },
    score: { timelyReport: true, reportAfterResolutionSec: 40 },
    claimsAudit: { reviewed: true, passed: true, finalDeliveryVerified: true },
    reviewedReportLatencySec: 120 };
  expect(summarizeTrials([row])).toMatchObject({ reportedWithin90Sec: 1, reviewedReportsWithin90Sec: 0 });
  expect(summarizeTrials([{ ...row, reviewedReportLatencySec: 80 }]))
    .toMatchObject({ reviewedReportsWithin90Sec: 1 });
});
