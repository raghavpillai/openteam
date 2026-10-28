import { createHash } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import {
  renderTaskProgressContext,
  validateTaskProgress,
  type TaskProgress,
  type TaskProgressInput,
} from "@openteam/contracts/task-progress";
import { Prisma, type PrismaClient } from "@openteam/db";
import type { AgentMessaging, ToolContext } from "./index";
import { automationContinuationRoute } from "./automation-results";

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export const taskProgress = (value: unknown): TaskProgress | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as TaskProgress;
  return typeof p.runId === "string" &&
    typeof p.revision === "number" &&
    Array.isArray(p.remaining) &&
    Array.isArray(p.evidence)
    ? p
    : null;
};

export const taskProgressContext = (value: unknown): string => {
  const p = taskProgress(value);
  return p ? renderTaskProgressContext(p) : "";
};

export async function notifyTaskProgress(
  tx: Prisma.TransactionClient,
  messaging: AgentMessaging,
  subagent: {
    id: string;
    parentBotId: string;
    parentRunId: string;
    parentChannelId: string;
    description: string;
  },
  progress: TaskProgress,
  key: string
) {
  const route = await automationContinuationRoute(tx, subagent.parentBotId, subagent.parentRunId);
  if (!route) return null;
  const source = await tx.run.findUnique({
    where: { id: subagent.parentRunId },
    include: { inboxEvents: { take: 1, select: { payload: true } } },
  });
  const sourceContext = (
    source?.inboxEvents[0]?.payload as { taskContextRunId?: string } | undefined
  )?.taskContextRunId;
  const routine =
    route.origin === "routine" && route.automationContextRunId
      ? await tx.routineExecution.findUnique({
          where: { runId: route.automationContextRunId },
          select: { routineRevision: { select: { name: true, prompt: true } } },
        })
      : null;
  const deliveryContext = routine
    ? `This task belongs to a saved routine. Its delivery instruction governs whether to speak: ${JSON.stringify(routine.routineRevision)}. This progress event does not hand off or stop the automation.`
    : "";
  const wake = await messaging.enqueueWake(tx, {
    botId: subagent.parentBotId,
    channelId: subagent.parentChannelId,
    origin: "background_revival",
    taskContextRunId: sourceContext ?? subagent.parentRunId,
    type: "subagent.progress",
    clientId: `task-progress:${subagent.id}:${key}`,
    priority: 260,
    content: `[Delegated task progress — not task completion]\nTask: ${subagent.description}\nTask ID: sand-subagent-${subagent.id}\n${deliveryContext}\n${JSON.stringify(progress)}\nReport a genuinely new verified outcome or actionable blocker to the user when relevant, with its actual evidence and uncertainty. The task still owns its remaining work. Do not resume or redispatch a working task for this notification; a waiting task already has its check recorded. A blocked task needs your decision or the user's input. A policy interpretation is not a returned tool refusal. Respect newer cancellation and scope instructions; never repeat completed side effects. Do not announce unchanged polling.`,
  });
  return wake.run.id;
}

/** State, receipt and parent wake commit together. A stable milestone key deduplicates
 * even when a client retries with a different transport call id. */
export async function reportTaskProgress(
  prisma: PrismaClient,
  messaging: AgentMessaging,
  context: ToolContext,
  input: TaskProgressInput
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`task-progress:${context.botId}`}))`;
    await tx.$queryRaw`SELECT id FROM "Subagent" WHERE "childBotId" = ${context.botId}::uuid FOR UPDATE`;
    const subagent = await tx.subagent.findUnique({ where: { childBotId: context.botId } });
    if (
      !subagent ||
      subagent.currentRunId !== context.runId ||
      !["running", "queued"].includes(subagent.status)
    )
      throw new ApiError(
        409,
        "task_progress_stale",
        "Only the current, active delegated task may report progress"
      );
    const scope = `task-progress:${subagent.id}`;
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))
        )
      )
      .digest("hex");
    const receipt = await tx.idempotencyRecord.findUnique({
      where: { scope_key: { scope, key: input.key } },
    });
    if (receipt) {
      if (receipt.requestHash !== requestHash)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "A milestone key cannot be reused for different progress"
        );
      const current = taskProgress(subagent.progress);
      return {
        ...(receipt.response as Record<string, unknown>),
        progress: subagent.progress,
        revision: subagent.progressRevision,
        deferred: current?.state === "waiting" || current?.state === "blocked",
      };
    }
    const effectiveInput =
      input.remaining.length && !input.deadline && subagent.deadlineAt
        ? { ...input, deadline: subagent.deadlineAt.toISOString() }
        : input;
    validateTaskProgress(effectiveInput);
    const progress: TaskProgress = {
      ...effectiveInput,
      runId: context.runId,
      revision: subagent.progressRevision + 1,
    };
    await tx.subagent.update({
      where: { id: subagent.id },
      data: {
        progress: json(progress),
        progressRevision: progress.revision,
        nextCheckAt: input.checkAt ? new Date(input.checkAt) : null,
        deadlineAt: effectiveInput.deadline ? new Date(effectiveInput.deadline) : null,
      },
    });
    const previous = taskProgress(subagent.progress);
    const meaningful =
      !previous ||
      previous.summary !== progress.summary ||
      JSON.stringify(previous.evidence) !== JSON.stringify(progress.evidence) ||
      JSON.stringify(previous.remaining) !== JSON.stringify(progress.remaining) ||
      (["blocked", "complete"].includes(progress.state) && previous.state !== progress.state);
    const wakeRunId = meaningful
      ? await notifyTaskProgress(tx, messaging, subagent, progress, input.key)
      : null;
    const response = {
      saved: true,
      progress: json(progress),
      revision: progress.revision,
      wake_run_id: wakeRunId,
      deferred: input.state === "waiting" || input.state === "blocked",
    };
    await tx.idempotencyRecord.create({
      data: {
        scope,
        key: input.key,
        requestHash,
        status: "completed",
        response,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
      },
    });
    await tx.event.create({
      data: {
        topic: "subagent.progress",
        entityId: subagent.id,
        payload: { subagentId: subagent.id, revision: progress.revision, state: input.state },
      },
    });
    return response;
  });
}

/** Polling this durable index costs no model call. The same pass runs after restart;
 * locks + currentRunId fence competing dispatchers and cancellation. */
export async function dispatchTaskContinuations(
  prisma: PrismaClient,
  messaging: AgentMessaging,
  now = new Date()
): Promise<number> {
  const due = await prisma.subagent.findMany({
    where: {
      status: "waiting",
      nextCheckAt: { lte: now },
      parentBot: { status: "active" },
      childBot: { status: "active" },
    },
    orderBy: { nextCheckAt: "asc" },
    take: 50,
    select: { id: true },
  });
  let dispatched = 0;
  for (const { id } of due) {
    dispatched += await prisma.$transaction(async (tx) => {
      // Same capacity lock as Task launches, so a parked graphical task releases
      // its desktop but cannot resume on top of another graphical task.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('openteam-subagent-capacity'))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`task-continuation:${id}`}))`;
      await tx.$queryRaw`SELECT id FROM "Subagent" WHERE id = ${id}::uuid FOR UPDATE`;
      const sub = await tx.subagent.findUnique({ where: { id } });
      if (!sub || sub.status !== "waiting" || !sub.nextCheckAt || sub.nextCheckAt > now) return 0;
      const progress = taskProgress(sub.progress);
      if (!progress || !sub.currentRunId) return 0;
      if (sub.deadlineAt && sub.deadlineAt <= now) {
        const expired: TaskProgress = {
          ...progress,
          state: "blocked",
          blockSource: "runtime",
          summary: "The recorded response deadline elapsed before this task could resume.",
          nextAction:
            "Inspect the current state and report whether the original goal is still attainable.",
          revision: sub.progressRevision + 1,
        };
        delete (expired as { checkAt?: string }).checkAt;
        await tx.subagent.update({
          where: { id },
          data: { progress: json(expired), progressRevision: expired.revision, nextCheckAt: null },
        });
        await notifyTaskProgress(tx, messaging, sub, expired, `deadline:${expired.revision}`);
        return 0;
      }
      if (
        sub.subagentType === "computerUse" &&
        (await tx.subagent.count({
          where: {
            parentBotId: sub.parentBotId,
            id: { not: id },
            subagentType: "computerUse",
            status: { in: ["provisioning", "queued", "running"] },
          },
        }))
      )
        return 0;
      const previous = await tx.run.findUnique({ where: { id: sub.currentRunId } });
      if (!previous?.channelId || ["queued", "running"].includes(previous.status)) return 0;
      const key = `continuation:${id}:${sub.progressRevision}`;
      const wake = await messaging.enqueueWake(tx, {
        botId: sub.childBotId,
        channelId: previous.channelId,
        origin: "agent",
        type: "subagent.continue",
        clientId: key,
        priority: 350,
        content: `Continue the same delegated task after its recorded wait.\nOriginal scope and approval context:\n${sub.prompt}\n\n${taskProgressContext(progress)}\n\nNext authorized step: ${progress.nextAction}\nInspect the current state first. A previous send or submit may already have succeeded. Do not repeat it without reconciliation, do not expand approval, and report a new wait with a new milestone key.`,
      });
      await tx.subagentAttempt.create({
        data: {
          subagentId: id,
          parentRunId: sub.parentRunId,
          parentChannelId: sub.parentChannelId,
          parentToolCallId: key,
          childRunId: wake.run.id,
          description: sub.description,
          prompt: progress.nextAction ?? sub.prompt,
          status: "queued",
        },
      });
      const resumed: TaskProgress = {
        ...progress,
        state: "working",
        runId: wake.run.id,
        revision: sub.progressRevision + 1,
      };
      delete (resumed as { checkAt?: string }).checkAt;
      await tx.subagent.update({
        where: { id },
        data: {
          status: "queued",
          currentRunId: wake.run.id,
          progress: json(resumed),
          progressRevision: resumed.revision,
          nextCheckAt: null,
          completedAt: null,
        },
      });
      await tx.event.create({
        data: {
          topic: "subagent.continued",
          entityId: id,
          payload: { runId: wake.run.id, revision: resumed.revision },
        },
      });
      return 1;
    });
  }
  return dispatched;
}

/** A finished model turn must not discard its explicitly recorded obligations. */
export async function settleTaskProgress(
  tx: Prisma.TransactionClient,
  messaging: AgentMessaging,
  subagent: {
    id: string;
    progress: Prisma.JsonValue;
    progressRevision: number;
    nextCheckAt: Date | null;
    parentBotId: string;
    parentRunId: string;
    parentChannelId: string;
    description: string;
  },
  attemptId: string,
  runId: string
): Promise<boolean> {
  const progress = taskProgress(subagent.progress);
  if (progress?.runId === runId && progress.tracking !== "initial" && progress.remaining.length) {
    // The turn can end while its goal remains owned. Only an explicit future
    // check resumes it; blockers and unexpected early finishes return ownership
    // to the parent, rather than silently declaring the task done.
    const waiting = progress.state === "waiting" && subagent.nextCheckAt !== null;
    const pending =
      waiting || progress.state === "blocked"
        ? progress
        : {
            ...progress,
            state: "blocked" as const,
            blockSource: "runtime" as const,
            summary: "The worker ended while its recorded obligations remained unfinished.",
            nextAction:
              progress.nextAction ??
              "Review the unfinished work and decide the next authorized step.",
            revision: subagent.progressRevision + 1,
          };
    const saved = await tx.subagent.updateMany({
      where: {
        id: subagent.id,
        currentRunId: runId,
        status: { notIn: ["completed", "failed", "stopped"] },
      },
      data: {
        status: "waiting",
        progress: JSON.parse(JSON.stringify(pending)),
        progressRevision: pending.revision,
        nextCheckAt: waiting ? subagent.nextCheckAt : null,
      },
    });
    if (!saved.count) return true;
    await tx.subagentAttempt.update({
      where: { id: attemptId },
      data: { status: "completed", completedAt: new Date() },
    });
    await tx.event.create({
      data: {
        topic: "subagent.waiting",
        entityId: subagent.id,
        payload: {
          runId: runId,
          nextCheckAt: waiting ? subagent.nextCheckAt?.toISOString() : null,
        },
      },
    });
    if (pending !== progress)
      await notifyTaskProgress(tx, messaging, subagent, pending, `unfinished:${pending.revision}`);
    return true;
  }
  return false;
}

export function initialTaskProgress(runId: string): TaskProgress {
  return {
    key: "task-accepted",
    state: "working",
    summary: "Delegated task accepted; no external outcome has been verified.",
    evidence: [],
    remaining: [
      "Complete the outcome in the current parent instruction within its approval and limits.",
    ],
    nextAction: "Inspect current state and carry out the authorized task.",
    runId,
    revision: 0,
    tracking: "initial",
  };
}
