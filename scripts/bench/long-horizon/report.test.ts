import { expect, test } from "bun:test";
import { distribution, summarizeTrials } from "./report";

test("missing timing and invalid infrastructure attempts cannot inflate completion or speed", () => {
  const row = { id: "valid", audit: { fullyFinished: true, providerOutcome: true, unfinishedReviews: [], abandonedReviews: [] }, score: { reportAfterResolutionSec: 60, timelyReport: true } };
  const failed = { ...row, id: "failed", audit: { ...row.audit, fullyFinished: false }, score: { reportAfterResolutionSec: null } };
  const invalid = { ...row, id: "disk-pressure", infrastructureInvalid: true, score: { reportAfterResolutionSec: 1, timelyReport: true } };
  expect(summarizeTrials([row, failed, invalid])).toMatchObject({ validTrials: 2, fullyFinished: 1,
    infrastructureInvalid: ["disk-pressure"], reportedWithin90Sec: 1,
    reportLatencySec: { observed: 1, median: 60, p90: 60, max: 60 } });
  expect(distribution([5, 9, null, 1, 3])).toEqual({ observed: 4, median: 4, p90: 9, max: 9 });
});
