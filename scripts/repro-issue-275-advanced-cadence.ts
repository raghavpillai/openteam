// Characterizes desktop Advanced schedule mismatches using real production helpers.
// Run with: bun scripts/repro-issue-275-advanced-cadence.ts
// A passing assertion means the stated mismatch is present, not that it is fixed.
import assert from "node:assert/strict";
import {
  DEFAULT_ROUTINE_SCHEDULE,
  describeRoutineSchedule,
  routineScheduleValue,
} from "../apps/desktop/src/renderer/lib/routines";
import { nextRoutineRun, normalizeRoutineSchedule } from "../packages/messaging/src/routines";

const every45 = {
  ...DEFAULT_ROUTINE_SCHEDULE,
  preset: "advanced" as const,
  advancedTimeMode: "every" as const,
  advancedEveryAmount: 45,
  advancedEveryUnit: "m" as const,
};
const text = describeRoutineSchedule(every45);
const expression = routineScheduleValue(every45);
const schedule = normalizeRoutineSchedule(expression, "UTC");
let next = new Date("2026-11-12T12:00:00Z");
const fired: string[] = [];
for (let i = 0; i < 3; i++) {
  next = nextRoutineRun(schedule, next);
  fired.push(next.toISOString());
}
assert.equal(text, "Every 45 minutes");
assert.equal(expression, "*/45 * * * *");
assert.deepEqual(fired, ["2026-11-12T12:45:00.000Z", "2026-11-12T13:00:00.000Z", "2026-11-12T13:45:00.000Z"]);
console.log(JSON.stringify({ case: "45-minute cadence", text, expression, fired }));

// Another manifestation of the previously documented every-N-days filter bug.
const restricted = {
  ...DEFAULT_ROUTINE_SCHEDULE,
  preset: "advanced" as const,
  advancedTimeMode: "every" as const,
  advancedDayMode: "month-days" as const,
  advancedMonthDays: [10, 20],
  advancedEveryAmount: 1,
  advancedEveryUnit: "d" as const,
  advancedFromTime: "09:00",
};
const restrictedText = describeRoutineSchedule(restricted);
const restrictedExpression = routineScheduleValue(restricted);
const unexpected = nextRoutineRun(normalizeRoutineSchedule(restrictedExpression, "UTC"), new Date("2026-11-12T00:00:00Z"));
assert.equal(restrictedText, "Every 1 day on the 10th, 20th");
assert.equal(restrictedExpression, "0 9 */1 * *");
assert.equal(unexpected.toISOString(), "2026-11-12T09:00:00.000Z");
console.log(JSON.stringify({ case: "selected month days discarded", text: restrictedText, expression: restrictedExpression, unexpected }));

const januaryOnly = {
  ...DEFAULT_ROUTINE_SCHEDULE,
  preset: "advanced" as const,
  advancedMonths: [1],
  advancedTimeMode: "at-times" as const,
  advancedTimes: ["08:00"],
};
const monthDescription = describeRoutineSchedule(januaryOnly);
const monthExpression = routineScheduleValue(januaryOnly);
const nextJanuaryRun = nextRoutineRun(normalizeRoutineSchedule(monthExpression, "UTC"), new Date("2026-11-12T00:00:00Z"));
assert(monthDescription.startsWith("Every day at "));
assert(!monthDescription.includes("January"));
assert.equal(monthExpression, "0 8 * 1 *");
assert.equal(nextJanuaryRun.toISOString(), "2027-01-01T08:00:00.000Z");
console.log(JSON.stringify({ case: "month restriction omitted from summary", text: monthDescription, expression: monthExpression, next: nextJanuaryRun }));
console.log(JSON.stringify({ checks: 3, outcomes: [
  { name: "Advanced Every 45 minutes alternates 45- and 15-minute gaps", result: "confirmed" },
  { name: "Advanced Every N days discards selected month days", result: "confirmed" },
  { name: "Advanced summaries omit selected months", result: "confirmed" },
] }));
