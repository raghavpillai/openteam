// Capture the original exception hidden behind dispatch's generic failure record.
// OPENTEAM_TEST_DATABASE_URL=... bun scripts/recheck-issue-275-timeout.ts
import assert from "node:assert/strict";
import { setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAuditHarness } from "./repro-issue-275-harness";
import { RoutineService } from "../packages/messaging/src/routines";

const { db, fixture, close } = await createAuditHarness();
const errors: Array<{ code?: string; message: string }> = [];
try {
  setSystemTime(new Date("2025-11-12T12:00:00Z"));
  const f = await fixture();
  try {
    const g = await f.group({ type: "cron", schedule: "@every 5m" });
    setSystemTime(new Date("2026-11-12T12:00:00Z"));
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === "$transaction") return (work: any, options: any) => target.$transaction(async tx => {
        try { return await work(tx); }
        catch (error: any) { errors.push({ code: error.code, message: error.message }); throw error; }
      }, options);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const service = new RoutineService(wrapped, f.messaging, f.store);
    const result = await service.dispatchDue(new Date());
    const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: g.routineId } });
    assert.equal(result, 0);
    assert.equal(execution.status, "failed");
    assert(errors.some(e => e.code === "P2028" && /expired|timeout|timed out/i.test(e.message)));
    console.log(JSON.stringify({ result, status: execution.status, originalErrors: errors }));
  } finally { await f.cleanup(); }
} finally { setSystemTime(); await close(); }
