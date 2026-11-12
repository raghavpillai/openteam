// Additional #275 lifecycle/identity characterization. Passing reproduces the
// stated behavior, not a fix. Uses an EMPTY disposable current-schema database.
// OPENTEAM_TEST_DATABASE_URL=... bun scripts/repro-issue-275-revision-chaos.ts [filter]
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setSystemTime } from "bun:test";
import { createAuditHarness } from "./repro-issue-275-harness";

const { db, fixture, close } = await createAuditHarness();
const outcomes: Array<{ name: string; result: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try { await fn(); outcomes.push({ name, result: "confirmed" }); console.log(`CONFIRMED: ${name}`); }
  catch (error) { outcomes.push({ name, result: "FAILED" }); console.error(name, error); }
  finally { setSystemTime(); }
}
const event = () => ({ id: randomUUID(), source: "webhook", kind: "received", text: "New event" });
try {
  await check("coalescing a new event changes a queued bot run's prompt without changing its recorded revision", async () => {
    const f = await fixture({ trigger: { type: "webhook" }, enabled: true });
    try {
      const v1 = "ORIGINAL_REVISION_INSTRUCTION";
      const v2 = "REPLACEMENT_REVISION_INSTRUCTION";
      await f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: f.routineId, prompt: v1 });
      await f.service.dispatchEvent({ kind: "bot", id: f.botId }, event());
      const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: f.routineId }, include: { routineRevision: true } });
      assert.equal(execution.routineRevision.prompt, v1);
      assert((await db.inboxEvent.findFirstOrThrow({ where: { runId: execution.runId! } })).payload.content.includes(v1));
      await f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: f.routineId, prompt: v2 });
      await f.service.dispatchEvent({ kind: "bot", id: f.botId }, event());
      const after = await db.routineExecution.findUniqueOrThrow({ where: { id: execution.id }, include: { routineRevision: true } });
      assert.equal(after.routineRevision.prompt, v1);
      const claimed = await f.worker.claim(f.botId);
      assert.equal(claimed?.runId, execution.runId);
      assert(claimed.content.includes(v2));
      assert(!claimed.content.includes(v1));
    } finally { await f.cleanup(); }
  });

  await check("control: coalescing a group event preserves the queued execution's original instruction", async () => {
    const f = await fixture();
    try {
      const g = await f.group({ type: "webhook" });
      const owner = { kind: "group" as const, id: g.channelId };
      const v1 = "ORIGINAL_GROUP_REVISION", v2 = "REPLACEMENT_GROUP_REVISION";
      await f.service.mutateOwner(owner, randomUUID(), null, { action: "update", id: g.routineId, prompt: v1 });
      await f.service.dispatchEvent(owner, event());
      const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: g.routineId } });
      await f.service.mutateOwner(owner, randomUUID(), null, { action: "update", id: g.routineId, prompt: v2 });
      await f.service.dispatchEvent(owner, event());
      const claimed = await f.worker.claim(f.botId);
      assert(claimed?.content.includes(v1));
      assert(!claimed.content.includes(v2));
      assert.equal((await db.routineRevision.findUniqueOrThrow({ where: { id: execution.routineRevisionId } })).prompt, v1);
    } finally { await f.cleanup(); }
  });

  await check("a prompt-only update resets a group interval's due time without any file reconciliation", async () => {
    setSystemTime(new Date("2026-11-12T12:00:00Z"));
    const f = await fixture();
    try {
      const g = await f.group({ type: "cron", schedule: "@every 1h" });
      const before = await db.routine.findUniqueOrThrow({ where: { id: g.routineId } });
      assert.equal(before.nextRunAt?.toISOString(), "2026-11-12T13:00:00.000Z");
      setSystemTime(new Date("2026-11-12T12:30:00Z"));
      await f.service.mutateOwner({ kind: "group", id: g.channelId }, randomUUID(), null, { action: "update", id: g.routineId, prompt: "A prompt-only edit" });
      assert.equal((await db.routine.findUniqueOrThrow({ where: { id: g.routineId } })).nextRunAt?.toISOString(), "2026-11-12T13:30:00.000Z");
      assert.equal(await f.service.dispatchDue(new Date("2026-11-12T13:00:00Z")), 0);
    } finally { await f.cleanup(); }
  });

  await check("an uncertain create retried with edited input silently returns the original routine", async () => {
    const f = await fixture();
    try {
      const callId = randomUUID();
      const first = await f.service.mutate(f.botId, callId, null, { action: "create", name: "Original request", prompt: "Old instruction", schedule: "@every 1h" });
      // Same request ID retained by a creation form after a lost response;
      // the user edits the fields before retrying.
      const second = await f.service.mutate(f.botId, callId, null, { action: "create", name: "Edited request", prompt: "New instruction", schedule: "@every 2h" });
      assert.equal(second.id, first.id);
      const row = await db.routine.findUniqueOrThrow({ where: { id: String(second.id) } });
      assert.equal(row.name, "Original request");
      assert.equal(row.prompt, "Old instruction");
      assert.equal(row.scheduleText, "@every 1h");
      assert.equal(second.created, true);
    } finally { await f.cleanup(); }
  });

  await check("a UUID-shaped folder can make a different routine resolve when addressed by UUID", async () => {
    const f = await fixture();
    try {
      const second = await f.service.mutate(f.botId, randomUUID(), null, { action: "create", name: f.routineId, prompt: "Different routine", schedule: "@every 1h", enabled: false });
      assert.equal(second.folder, f.routineId);
      await f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: String(second.id), name: "Different routine" });
      await f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: f.routineId, name: "Original routine updated" });
      const addressed = await f.service.detail(f.botId, f.routineId);
      assert.equal(addressed.id, second.id);
      assert.notEqual(addressed.id, f.routineId);
      // Agent UpdateRoutine passes no expectedRevision. A caller carrying
      // the original row's revision can get a conflict instead; the identity
      // ambiguity still changes the wrong row on the actual agent path.
      await f.service.mutate(f.botId, randomUUID(), null, { action: "resume", id: f.routineId });
      assert.equal((await db.routine.findUniqueOrThrow({ where: { id: String(second.id) } })).enabled, true);
      assert.equal((await db.routine.findUniqueOrThrow({ where: { id: f.routineId } })).enabled, false);
    } finally { await f.cleanup(); }
  });

  await check("a run fired by a later schedule is described to the model as firing on the first schedule", async () => {
    setSystemTime(new Date("2026-11-12T12:00:00Z"));
    const f = await fixture({ trigger: { type: "group", listeners: [{ type: "cron", schedule: "CRON_TZ=UTC 0 18 * * *" }, { type: "cron", schedule: "CRON_TZ=UTC 0 13 * * *" }] }, enabled: true });
    try {
      assert.equal((await f.read()).nextRunAt?.toISOString(), "2026-11-12T13:00:00.000Z");
      assert.equal(await f.service.dispatchDue(new Date("2026-11-12T13:00:00Z")), 1);
      const execution = await db.routineExecution.findFirstOrThrow({ where: { routineId: f.routineId } });
      const wake = await db.inboxEvent.findFirstOrThrow({ where: { runId: execution.runId! } });
      assert(wake.payload.content.includes("0 18 * * *"));
      assert(!wake.payload.content.includes("0 13 * * *"));
      assert.equal(execution.scheduledFor.toISOString(), "2026-11-12T13:00:00.000Z");
    } finally { await f.cleanup(); }
  });

  console.log(JSON.stringify({ checks: outcomes.length, outcomes }));
  assert(outcomes.length > 0);
  assert(outcomes.every(o => o.result === "confirmed"));
} finally {
  setSystemTime();
  await close();
}
