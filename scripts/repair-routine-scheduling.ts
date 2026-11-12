/** Inspect affected pre-upgrade schedules; use --apply only after reviewing the dry run.
 * DATABASE_URL=... bun scripts/repair-routine-scheduling.ts [--apply]
 * Does not dispatch work, change definitions, or modify paused routines/history.
 */
import { createPrismaClient, type PrismaClient } from "../packages/db/src/index";
import {
  nextRoutineTriggerRun,
  inferRoutineScheduleAnchor,
} from "../packages/messaging/src/routines";
import { readUserTimeZone } from "../packages/messaging/src/user-time-zone";

export async function repairRoutineScheduling(
  db: PrismaClient,
  options: { apply?: boolean; now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const changes: Array<{
    id: string;
    from: string | null;
    to: string | null;
    anchor: string;
    applied: boolean;
  }> = [];
  const errors: Array<{ id: string; code: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await db.routine.findMany({
      where: {
        enabled: true,
        deletedAt: null,
        validationError: null,
        scheduleKind: { not: "event" },
        scheduleAnchorAt: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 100,
    });
    if (!page.length) break;
    cursor = page.at(-1)!.id;
    for (const { id } of page) {
      try {
        const change = await db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine:${id}`}))`;
          const routine = await tx.routine.findUnique({ where: { id } });
          if (
            !routine ||
            !routine.enabled ||
            routine.deletedAt ||
            routine.validationError ||
            routine.scheduleAnchorAt ||
            routine.scheduleKind === "event"
          )
            return;
          const anchor = await inferRoutineScheduleAnchor(tx, routine);
          let nextRunAt = routine.nextRunAt;
          // Already-due occurrences are settled/advanced by normal dispatch,
          // which now recognizes committed occurrences across revisions.
          if (!nextRunAt || nextRunAt > now) {
            const earliest = nextRoutineTriggerRun(
              routine.trigger as Record<string, unknown>,
              routine,
              now,
              await readUserTimeZone(tx),
              anchor
            );
            if (!nextRunAt || earliest < nextRunAt) nextRunAt = earliest;
          }
          if (options.apply)
            await tx.routine.update({
              where: { id },
              data: { nextRunAt, scheduleAnchorAt: anchor },
            });
          return {
            id,
            from: routine.nextRunAt?.toISOString() ?? null,
            to: nextRunAt?.toISOString() ?? null,
            anchor: anchor.toISOString(),
            applied: !!options.apply,
          };
        });
        if (change) changes.push(change);
      } catch {
        errors.push({ id, code: "schedule_repair_failed" });
      }
    }
  } while (cursor);
  return { mode: options.apply ? "apply" : "dry-run", changes, errors };
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required; use a disposable database when testing.");
  if (process.argv.slice(2).some((argument) => argument !== "--apply"))
    throw new Error("Usage: bun scripts/repair-routine-scheduling.ts [--apply]");
  const db = createPrismaClient(url);
  try {
    const result = await repairRoutineScheduling(db, { apply: process.argv.includes("--apply") });
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
