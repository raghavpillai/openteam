import { createHash } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import {
  validateTaskProgress,
  type RequestProgressInput,
  type TaskProgress,
} from "@openteam/contracts/task-progress";
import { Prisma, type PrismaClient } from "@openteam/db";
import type { AgentMessaging, ToolContext } from "./index";
import { taskProgress } from "./task-progress";
import { requestIsStopped } from "./request-state";
export { requestIsStopped } from "./request-state";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const openWorkers = ["provisioning", "queued", "running", "waiting"] as const;
const lock = (tx: Prisma.TransactionClient, botId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bot-run-claim:${botId}`}))`;

async function canContinueRequest(
  tx: Prisma.TransactionClient,
  root: { botId: string; channelId: string | null }
) {
  if (!root.channelId) return false;
  const bot = await tx.bot.findUnique({ where: { id: root.botId }, select: { status: true } });
  return (
    bot?.status === "active" &&
    !!(await tx.channel.findFirst({
      where: {
        id: root.channelId,
        archivedAt: null,
        members: { some: { botId: root.botId } },
      },
      select: { id: true },
    }))
  );
}

/** IDs link ownership, never authorization. No original user text or credentials
 * are copied into this record. The conversation remains the source of scope. */
async function requestForRun(
  tx: Prisma.TransactionClient,
  botId: string,
  runId: string,
  requestedId?: string
) {
  const source = await tx.run.findUnique({
    where: { id: runId },
    include: { inboxEvents: { take: 1, select: { payload: true } } },
  });
  if (!source || source.botId !== botId || source.status === "cancelled")
    throw new ApiError(409, "request_context_inactive", "The request context is no longer active");
  if (source.origin === "routine") return null;
  const context = (source.inboxEvents[0]?.payload as { taskContextRunId?: string } | undefined)
    ?.taskContextRunId;
  const root = await tx.run.findUnique({ where: { id: requestedId ?? context ?? runId } });
  if (!root || root.botId !== botId || root.channelId !== source.channelId)
    throw new ApiError(
      403,
      "request_not_owned",
      "The request must belong to this agent and conversation"
    );
  if (requestIsStopped(root))
    throw new ApiError(
      409,
      "request_stopped",
      "This request was stopped. A new instruction needs a new request; it does not restore earlier approval."
    );
  // Saved automations already have their own owner, context and delivery route.
  if (root.origin === "routine") return null;
  if (!(await canContinueRequest(tx, root)))
    throw new ApiError(
      409,
      "request_channel_missing",
      "The request's agent and original delivery channel must still be active"
    );
  return root;
}

export async function ensureRequestForTask(
  tx: Prisma.TransactionClient,
  botId: string,
  runId: string,
  requestedId?: string
) {
  await lock(tx, botId);
  const root = await requestForRun(tx, botId, runId, requestedId);
  if (!root) return null;
  const prior = taskProgress(root.requestProgress);
  if (prior?.state === "complete")
    throw new ApiError(
      409,
      "request_finished",
      "Start a new request for new work; do not reopen a completed request implicitly."
    );
  if (!root.requestProgress) {
    const progress: TaskProgress = {
      key: "request-start",
      state: "working",
      runId: root.id,
      revision: 1,
      tracking: "initial",
      summary:
        "A delegated step is in progress; the parent owns verification of the user's requested outcome.",
      evidence: [`run:${root.id}:user-request`, `message:${root.userMessageId}`],
      remaining: ["Verify the requested outcome and deliver its result or actionable blocker."],
      nextAction:
        "Reconcile the delegated result against the original user request, not only the worker's scoped step.",
    };
    await tx.run.update({
      where: { id: root.id },
      data: { requestProgress: json(progress), requestRevision: 1 },
    });
  } else if (prior) {
    // A new, explicitly scoped dispatch replaces a parent wait or a resolved
    // approval blocker. It does not change the child's authorization contract.
    const { checkAt: _, blockSource: __, toolError: ___, ...previous } = prior;
    const progress: TaskProgress = {
      ...previous,
      state: "working",
      key: `dispatch:${runId}`,
      revision: root.requestRevision + 1,
      evidence: [...prior.evidence.slice(-19), `run:${runId}:scoped-dispatch`],
    };
    await cancelQueuedChecks(tx, root.id);
    await tx.run.update({
      where: { id: root.id },
      data: {
        requestProgress: json(progress),
        requestRevision: progress.revision,
        requestNextCheckAt: null,
        requestReconciliations: 0,
      },
    });
  }
  return root.id;
}

async function cancelQueuedChecks(tx: Prisma.TransactionClient, rootId: string) {
  const pending = await tx.inboxEvent.findMany({
    where: { status: "pending", idempotencyKey: { startsWith: `request-check:${rootId}:` } },
    select: { runId: true },
  });
  await tx.inboxEvent.updateMany({
    where: { status: "pending", idempotencyKey: { startsWith: `request-check:${rootId}:` } },
    data: { status: "completed", completedAt: new Date() },
  });
  if (pending.length)
    await tx.run.updateMany({
      where: { id: { in: pending.map((p) => p.runId) }, status: "queued" },
      data: {
        status: "cancelled",
        completedAt: new Date(),
        error: { code: "request_check_superseded" },
      },
    });
}

export async function reportRequestProgress(
  prisma: PrismaClient,
  context: ToolContext,
  input: RequestProgressInput
) {
  return prisma.$transaction(async (tx) => {
    await lock(tx, context.botId);
    const actor = await tx.run.findUnique({
      where: { id: context.runId },
      select: { status: true },
    });
    if (actor?.status !== "running")
      throw new ApiError(
        409,
        "request_context_inactive",
        "Only the active parent turn may update request progress"
      );
    const root = await requestForRun(tx, context.botId, context.runId, input.request_run_id);
    if (!root)
      throw new ApiError(
        403,
        "request_progress_unavailable",
        "Saved automations use their own durable task context"
      );
    const { request_run_id: _, ...milestone } = input;
    const scope = `request-progress:${root.id}`;
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(Object.entries(milestone).sort(([a], [b]) => a.localeCompare(b)))
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
          "request_progress_key_conflict",
          "A milestone key cannot be reused for different progress"
        );
      if (
        (receipt.response as { progress?: { revision?: number } } | null)?.progress?.revision !==
        root.requestRevision
      )
        throw new ApiError(
          409,
          "request_progress_superseded",
          "This milestone was superseded. Preserve the current request state instead of replaying an old wait or approval block."
        );
      return receipt.response;
    }
    validateTaskProgress(milestone);
    if (input.state === "working" && !input.remaining.length)
      throw new ApiError(
        400,
        "request_obligation_missing",
        "A working request must name its unfinished obligation; verified and delivered work is complete"
      );
    if (taskProgress(root.requestProgress)?.state === "complete")
      throw new ApiError(409, "request_finished", "This request is already complete");
    if (
      ["complete", "waiting"].includes(input.state) &&
      (await tx.subagent.count({
        where: { requestRunId: root.id, status: { in: [...openWorkers] } },
      }))
    )
      throw new ApiError(
        409,
        "request_has_unfinished_workers",
        "This request has unfinished workers. Keep their existing ownership, or reconcile/stop them before completing or scheduling a separate parent check."
      );
    const progress: TaskProgress = {
      ...milestone,
      runId: root.id,
      revision: root.requestRevision + 1,
    };
    await cancelQueuedChecks(tx, root.id);
    await tx.run.update({
      where: { id: root.id },
      data: {
        requestProgress: json(progress),
        requestRevision: progress.revision,
        requestNextCheckAt: input.checkAt ? new Date(input.checkAt) : null,
        requestReconciliations: 0,
      },
    });
    const response = json({
      request_run_id: root.id,
      progress,
      deferred: input.state === "waiting",
      ended: input.state === "complete",
    });
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
      data: { topic: "request.progress", entityId: root.id,
        payload: { botId: context.botId, requestRunId: root.id, revision: progress.revision, state: input.state } },
    });
    return response;
  });
}

async function enqueueCheck(
  tx: Prisma.TransactionClient,
  messaging: AgentMessaging,
  root: { id: string; botId: string; channelId: string | null; requestRevision: number; userMessageId: string; createdAt: Date },
  progress: TaskProgress
) {
  if (!root.channelId) throw new Error("A tracked request lost its delivery channel");
  await messaging.enqueueWake(tx, {
    botId: root.botId,
    channelId: root.channelId,
    origin: "background_revival",
    type: "request.check",
    clientId: `request-check:${root.id}:${progress.revision}`,
    priority: 250,
    taskContextRunId: root.id,
    content: `[Unfinished user request: ${root.id}]\nOriginal message: ${root.userMessageId}; received ${root.createdAt.toISOString()}.\n${JSON.stringify(progress)}\nReconcile the original requested outcome against the completed scoped steps. Read the original request with ReadTranscript if needed, paging back to its timestamp. Continue authorized work, or save waiting with its next check, or ask the concrete missing decision and save blocked. Complete only after verifying and delivering the requested outcome. A narrowly approved message does not authorize another send. Ownership grants no new permission. Apply newer instructions and cancellations; reconcile prior external actions before repeating them. Do not announce unchanged checks or ask whether to continue work the user already requested. Use ReportRequestProgress with this request_run_id.`,
  });
}

/** A model turn ending is not a request ending. Give missing parent bookkeeping
 * a bounded private reconciliation, without relaunching or widening a child. */
export async function settleRequestProgress(
  tx: Prisma.TransactionClient,
  messaging: AgentMessaging,
  botId: string,
  runId: string
) {
  await lock(tx, botId);
  const source = await tx.run.findUnique({
    where: { id: runId },
    include: { inboxEvents: { take: 1, select: { payload: true } } },
  });
  if (!source || requestIsStopped(source)) return;
  // Several independent completions can fold into one parent wake. Reconcile
  // every open request in this conversation, rather than losing the folded IDs.
  const roots = await tx.run.findMany({
    where: {
      botId,
      channelId: source.channelId,
      requestStoppedAt: null,
      requestProgress: { path: ["state"], equals: "working" },
    },
    select: { id: true },
    take: 100,
  });
  for (const { id } of roots) {
    const root = await tx.run.findUnique({ where: { id } });
    const p = taskProgress(root?.requestProgress);
    if (
      !root ||
      root.botId !== botId ||
      requestIsStopped(root) ||
      !p ||
      p.state !== "working" ||
      root.requestNextCheckAt
    )
      continue;
    if (!(await canContinueRequest(tx, root))) {
      await tx.run.update({
        where: { id },
        data: { requestStoppedAt: new Date(), requestNextCheckAt: null },
      });
      await cancelQueuedChecks(tx, id);
      continue;
    }
    if (await tx.subagent.count({ where: { requestRunId: id, status: { in: [...openWorkers] } } }))
      continue;
    if (
      await tx.inboxEvent.count({
        where: { idempotencyKey: { startsWith: `request-check:${id}:` }, status: "pending" },
      })
    )
      continue;
    if (root.requestReconciliations >= 3) continue;
    const attempts = root.requestReconciliations + 1;
    const progress: TaskProgress = {
      ...p,
      revision: root.requestRevision + 1,
      summary:
        "The requested outcome has no active worker or recorded next check; the parent must reconcile it.",
      ...(attempts === 3
        ? {
            state: "blocked",
            blockSource: "runtime",
            nextAction:
              "Explain the unresolved request and decide the next authorized step. Automatic bookkeeping reminders have reached their limit.",
          }
        : {}),
    };
    await tx.run.update({
      where: { id },
      data: {
        requestProgress: json(progress),
        requestRevision: progress.revision,
        requestReconciliations: attempts,
      },
    });
    await enqueueCheck(tx, messaging, root, progress);
  }
}

/** Recover a crash after the terminal model event but before its request was
 * reconciled. A live parent turn or pending check already owns that work. */
export async function recoverRequestProgress(prisma: PrismaClient, messaging: AgentMessaging) {
  const roots = await prisma.run.findMany({
    where: {
      // Filter before distinct: a cancelled request must not hide a recoverable
      // request in the same conversation.
      OR: [
        { status: { notIn: ["queued", "running", "cancelled"] } },
        { status: "cancelled", error: { path: ["code"], equals: "priority_peer_interrupt" } },
      ],
      requestStoppedAt: null,
      requestProgress: { path: ["state"], equals: "working" },
      bot: { status: "active" },
    },
    distinct: ["botId", "channelId"],
    select: { id: true, botId: true },
    take: 100,
  });
  for (const root of roots)
    await prisma.$transaction(async (tx) => {
      await lock(tx, root.botId);
      if (
        await tx.botRunLease.count({
          where: { botId: root.botId, scope: "foreground", expiresAt: { gt: new Date() } },
        })
      )
        return;
      await settleRequestProgress(tx, messaging, root.botId, root.id);
    });
}

/** Durable due-time dispatch; no process-local timer owns a user's request. */
export async function dispatchRequestChecks(
  prisma: PrismaClient,
  messaging: AgentMessaging,
  now = new Date()
) {
  const due = await prisma.run.findMany({
    where: { requestNextCheckAt: { lte: now }, requestStoppedAt: null, bot: { status: "active" } },
    select: { id: true, botId: true },
    take: 100,
  });
  let dispatched = 0;
  for (const item of due)
    dispatched += await prisma.$transaction(async (tx) => {
      await lock(tx, item.botId);
      const root = await tx.run.findUniqueOrThrow({ where: { id: item.id } });
      const p = taskProgress(root.requestProgress);
      if (
        !p ||
        p.state !== "waiting" ||
        requestIsStopped(root) ||
        !root.requestNextCheckAt ||
        root.requestNextCheckAt > now
      )
        return 0;
      if (!(await canContinueRequest(tx, root))) {
        await tx.run.update({
          where: { id: root.id },
          data: { requestStoppedAt: now, requestNextCheckAt: null },
        });
        await cancelQueuedChecks(tx, root.id);
        return 0;
      }
      // Keep the original deadline visible even if the computer was down past it.
      // The parent must inspect/recover, not silently replay an expired action.
      const progress: TaskProgress = {
        ...p,
        state: "working",
        revision: root.requestRevision + 1,
        reconciliationRequired: true,
      };
      delete (progress as { checkAt?: string }).checkAt;
      await tx.run.update({
        where: { id: root.id },
        data: {
          requestProgress: json(progress),
          requestRevision: progress.revision,
          requestNextCheckAt: null,
        },
      });
      await enqueueCheck(tx, messaging, root, progress);
      return 1;
    });
  return dispatched;
}

export async function stopRequestProgress(
  tx: Prisma.TransactionClient,
  botId: string,
  runId?: string
) {
  await lock(tx, botId);
  const source = runId
    ? await tx.run.findUnique({
        where: { id: runId },
        include: { inboxEvents: { take: 1, select: { payload: true, type: true } } },
      })
    : null;
  const sourcePayload = source?.inboxEvents[0]?.payload as { taskContextRunId?: string; automationContextRunId?: string } | undefined;
  const handoff = source?.inboxEvents.some(event => event.type === "automation.wake_parent")
    ? await tx.automationResult.findUnique({ where: { wakeRunId: source.id }, select: { runId: true } }) : null;
  const context = sourcePayload?.taskContextRunId ?? sourcePayload?.automationContextRunId ?? handoff?.runId ?? runId;
  let legacyOwners: string[] = [];
  if (!context) {
    // Older tasks may predate durable request progress. Discover their live
    // owners without treating every finished historical turn as unfinished work.
    const workers = await tx.subagent.findMany({
      where: { parentBotId: botId, status: { in: [...openWorkers] } },
      select: { requestRunId: true, parentRunId: true },
    });
    const active = await tx.run.findMany({
      where: { botId, OR: [
        { status: { in: ["queued", "running"] } },
        { id: { in: workers.map(worker => worker.requestRunId ?? worker.parentRunId) } },
      ] },
      select: { id: true, inboxEvents: { take: 1, select: { payload: true, type: true } } },
    });
    const handoffWakes = active.filter(run => run.inboxEvents.some(event => event.type === "automation.wake_parent"));
    const handoffs = handoffWakes.length ? await tx.automationResult.findMany({
      where: { wakeRunId: { in: handoffWakes.map(run => run.id) }, run: { botId } }, select: { runId: true, wakeRunId: true },
    }) : [];
    const handoffRoots = new Map(handoffs.map(result => [result.wakeRunId, result.runId]));
    legacyOwners = active.map(run => {
      const payload = run.inboxEvents[0]?.payload as { taskContextRunId?: string; automationContextRunId?: string } | undefined;
      return payload?.taskContextRunId ?? payload?.automationContextRunId ?? handoffRoots.get(run.id) ?? run.id;
    });
  }
  const roots = await tx.run.findMany({
    where: {
      botId,
      ...(context ? { id: context } : { OR: [
        { requestProgress: { not: Prisma.DbNull } },
        { id: { in: legacyOwners } },
      ] }),
      requestStoppedAt: null,
    },
    select: { id: true },
  });
  for (const root of roots) {
    await tx.run.update({
      where: { id: root.id },
      data: { requestStoppedAt: new Date(), requestNextCheckAt: null },
    });
    await cancelQueuedChecks(tx, root.id);
    await tx.event.create({ data: { topic: "request.stopped", entityId: root.id, payload: { botId, requestRunId: root.id } } });
  }
  return roots.length;
}

export async function requestProgressSnapshot(
  tx: Prisma.TransactionClient | PrismaClient,
  botId: string,
  channelId: string | null
) {
  const rows = await tx.run.findMany({
    where: {
      botId,
      channelId,
      requestStoppedAt: null,
      requestProgress: { not: Prisma.DbNull },
      OR: [
        { status: { not: "cancelled" } },
        { status: "cancelled", error: { path: ["code"], equals: "priority_peer_interrupt" } },
      ],
      NOT: { requestProgress: { path: ["state"], equals: "complete" } },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { id: true, userMessageId: true, createdAt: true, requestProgress: true, requestNextCheckAt: true },
  });
  return rows.map((r) => ({
    request_run_id: r.id,
    request_message_id: r.userMessageId,
    requested_at: r.createdAt.toISOString(),
    progress: r.requestProgress,
    nextCheckAt: r.requestNextCheckAt,
  }));
}

/** Checked while holding the same claim lock as progress and cancellation. */
export async function requestWakeAllowed(
  tx: Prisma.TransactionClient,
  wake: { botId: string; type: string; idempotencyKey: string; payload: unknown }
) {
  const context = (wake.payload as { taskContextRunId?: string } | null)?.taskContextRunId;
  if (!context) return wake.type !== "request.check";
  const root = await tx.run.findUnique({ where: { id: context } });
  // A recorded stop is authoritative even if this legacy context never saved
  // progress. Otherwise a late completion can wake a model to publish its result.
  if (root?.requestStoppedAt) return false;
  // Preserve legacy automation/revival routing. Only request-tracked contexts
  // and the new check type use this additional revision/cancellation fence.
  if (!root?.requestProgress) return wake.type !== "request.check";
  if (root.botId !== wake.botId || requestIsStopped(root))
    return false;
  if (taskProgress(root.requestProgress)?.state === "complete") return false;
  if (!(await canContinueRequest(tx, root))) return false;
  if (wake.type !== "request.check") return true;
  return (
    wake.idempotencyKey === `request-check:${root.id}:${root.requestRevision}` &&
    !!root.requestProgress
  );
}
