import { ApiError, type WakeParentInput } from "@openteam/contracts";
import { Prisma } from "@openteam/db";
import { renderAutomationHandoffPrompt, type AgentMessaging, type ToolContext, type WakeInput } from "./index";

export function automationContextRunId(runId: string, payload: unknown): string {
  const id =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).automationContextRunId
      : null;
  return typeof id === "string" ? id : runId;
}

async function pendingAutomationShells(
  tx: Prisma.TransactionClient,
  botId: string,
  familyIds: string[]
) {
  type ShellRecord = {
    shellKind?: string;
    tool?: string;
    result?: { details?: { status?: string; outputPath?: string; output_path?: string } };
  };
  // Avoid loading browser screenshots or unrelated tool results just to check
  // whether an automation has a background shell to drain.
  const items = await tx.runItem.findMany({
    where: {
      runId: { in: familyIds },
      kind: "command",
      status: "completed",
      content: { path: ["shellKind"], equals: "background" },
    },
    select: { content: true },
  });
  const pending = items
    .map((item) => item.content as ShellRecord)
    .filter((item) => item.result?.details?.status === "running");
  if (!pending.length) return false;
  const waits = await tx.runItem.findMany({
    where: {
      runId: { in: familyIds },
      kind: "tool",
      status: "completed",
      content: { path: ["tool"], equals: "AwaitShell" },
    },
    select: { content: true },
  });
  const records = waits.map((item) => item.content as ShellRecord);
  const receipts = await tx.inboxEvent.findMany({
    where: { botId, type: "shell.completed" },
    select: { payload: true },
  });
  return pending.some((item) => {
    const details = item.result!.details!;
    const path = details.outputPath ?? details.output_path;
    if (!path) return false;
    // AwaitShell may consume the completion itself, suppressing the callback.
    if (
      records.some(
        (record) =>
          record.tool === "AwaitShell" &&
          ["completed", "failed"].includes(record.result?.details?.status ?? "") &&
          (record.result?.details?.outputPath ?? record.result?.details?.output_path) === path
      )
    )
      return false;
    // A completion's block names its output on its own line, also once batched into another wake.
    return !receipts.some((receipt) => {
      const payload = receipt.payload as { content?: string; revival?: { block?: string } };
      return (payload.revival?.block ?? payload.content ?? "").split("\n").includes(`Full output: ${path}`);
    });
  });
}

/** Whether background work an automation context started (background subagents, or background
 * shells nothing has reported yet) is still running; its results wait until all of it is done. */
export async function automationBackgroundWorkRunning(
  tx: Prisma.TransactionClient,
  botId: string,
  rootId: string
): Promise<boolean> {
  const family = (await tx.run.findMany({
    where: {
      botId,
      origin: "routine",
      OR: [{ id: rootId }, { inboxEvents: { some: { payload: { path: ["automationContextRunId"], equals: rootId } } } }],
    },
    select: { id: true },
  })).map((entry) => entry.id);
  if (await tx.subagentAttempt.count({
    where: { parentRunId: { in: family }, status: { in: ["provisioning", "queued", "running"] } },
  })) return true;
  return pendingAutomationShells(tx, botId, family);
}

/** One saved occurrence can span several parent turns and delegated workers. Returns the
 * execution that settled, for what follows it (RoutineService.afterExecution). */
export async function reconcileRoutineExecution(
  tx: Prisma.TransactionClient,
  runId: string
): Promise<{ executionId: string; routineId: string } | undefined> {
  const run = await tx.run.findUnique({
    where: { id: runId },
    include: { inboxEvents: { take: 1, select: { payload: true } } },
  });
  if (!run || run.origin !== "routine") return;
  const rootId = automationContextRunId(run.id, run.inboxEvents[0]?.payload);
  const root = await tx.run.findFirst({
    where: { id: rootId, botId: run.botId, channelId: run.channelId, origin: "routine" },
  });
  if (!root) return;
  const family = await tx.run.findMany({
    where: {
      botId: root.botId,
      channelId: root.channelId,
      origin: "routine",
      OR: [
        { id: rootId },
        {
          inboxEvents: { some: { payload: { path: ["automationContextRunId"], equals: rootId } } },
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, completedAt: true, error: true },
  });
  if (family.some((entry) => ["queued", "running"].includes(entry.status)))
    return;
  const handoff = await tx.automationResult.findUnique({ where: { runId: rootId }, select: { wakeRunId: true } });
  // A handoff ends the automation; background work it started no longer reports to it.
  if (
    !handoff?.wakeRunId &&
    (await tx.subagentAttempt.count({
      where: {
        parentRunId: { in: family.map((entry) => entry.id) },
        status: { in: ["provisioning", "queued", "running"] },
      },
    }))
  )
    return;
  if (
    !handoff?.wakeRunId &&
    (await pendingAutomationShells(
      tx,
      root.botId,
      family.map((entry) => entry.id)
    ))
  )
    return;
  const final = family[0]!;
  const failedHandoff = !handoff?.wakeRunId && await tx.runItem.findFirst({ where: {
    runId: { in: family.map(entry => entry.id) }, status: "failed", kind: "tool",
    OR: [{ title: "WakeParent" }, { content: { path: ["arguments", "toolName"], equals: "WakeParent" } }],
  }, select: { id: true } });
  const status =
    failedHandoff ? "failed" : final.status === "completed"
      ? "completed"
      : final.status === "cancelled"
        ? "cancelled"
        : "failed";
  const updated = await tx.routineExecution.updateMany({
    where: { runId: rootId, status: { in: ["queued", "running"] } },
    data: {
      status,
      completedAt: final.completedAt ?? new Date(),
      ...(status === "completed" ? {} : { error: failedHandoff ? { code: "automation_handoff_failed", message: "The required parent handoff failed; no result was delivered", runItemId: failedHandoff.id } : final.error ?? Prisma.JsonNull }),
    },
  });
  if (!updated.count) return;
  const settled = await tx.routineExecution.findUnique({ where: { runId: rootId }, select: { id: true, routineId: true } });
  return settled ? { executionId: settled.id, routineId: settled.routineId } : undefined;
}

/** Shell and delegated-worker completions resume their owning automation. Once that
 * automation handed off to its parent, they are dropped (null). */
export async function automationContinuationRoute(
  tx: Prisma.TransactionClient,
  botId: string,
  sourceRunId: string
): Promise<Pick<WakeInput, "origin" | "automationContextRunId"> | null> {
  const source = await tx.run.findFirst({
    where: { id: sourceRunId, botId },
    include: { inboxEvents: { take: 1, select: { payload: true } } },
  });
  if (source?.origin !== "routine") return { origin: "background_revival" };
  const payload = source.inboxEvents[0]?.payload;
  const rootId = automationContextRunId(source.id, payload);
  const handoff = await tx.automationResult.findUnique({
    where: { runId: rootId },
    select: { wakeRunId: true },
  });
  if (handoff?.wakeRunId) return null;
  return { origin: "routine", automationContextRunId: rootId };
}

export const AUTOMATION_RUN_INSTRUCTIONS = [
  "## Automation run",
  "You are running an automation as a fresh subagent with the parent agent's work capabilities. Complete the saved instruction autonomously.",
  "- You can't change the visible transcript, message the user or another agent, react, ask a question, or surface a form, handoff, connector, draft, or share card. The only cards your work may raise are Auto-review approvals.",
  "- Older saved instructions may name SendMessage or SendToUser; neither exists in this run. Treat either as a request for user-visible communication and call WakeParent with the full payload instead.",
  "- WakeParent is the only way to reach the user or another agent from this run. Call it when the saved instruction asks you to ping, remind, tell, notify, ask, or say something to the user, even when the work succeeded, and when the parent must message an agent, make a decision, or take over a blocker. It ends your turn immediately, so include the complete outcome and what the parent should say or do.",
  "- Stay quiet by default: no acknowledgements, progress narration, or unsolicited offers. Guidance elsewhere to acknowledge, post updates, or ask with a widget doesn't apply here.",
  "- Email or messages to anyone but the user go out only when the saved instruction names that message and those recipients. Otherwise tell the parent to call DraftExternalMessage, and do not create the draft in the source app with Slack slack_send_message_draft, Gmail create_draft, Gmail update_draft, or another connector draft tool. Put that ask in WakeParent when you have it, and in your final message otherwise. Include the recipient, the channel or connector, the thread or other context, the proposed text, and why it should go out. The only exception is an email draft that the user asked to keep in their mailbox, or that must carry a file attachment: save it in their mailbox, with the email connector's create_draft or the mail app's own UI, send nothing, and do not ask the parent to draft it. Reading mail is not answering it.",
  "- When the result can wait for the parent's next natural stopping point, skip WakeParent and end with a complete final assistant message in plain text; it is saved silently as the automation result. Earlier assistant messages are not included.",
  // Children of a run report back to the run itself.
  "- You may delegate with Task. Background child completions resume this automation context, not the parent's chat. Incorporate their results before finishing. If more work remains with a child, you may end this turn and wait for its completion.",
].join("\n");

export async function wakeAutomationParent(
  messaging: AgentMessaging,
  context: ToolContext,
  input: WakeParentInput
) {
  if (!input.message.trim())
    throw new ApiError(
      400,
      "wake_parent_message_empty",
      "message must contain the complete handoff"
    );
  return messaging.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Run" WHERE "id" = ${context.runId}::uuid FOR UPDATE`;
    const run = await tx.run.findUnique({
      where: { id: context.runId },
      include: { inboxEvents: { take: 1, select: { payload: true } } },
    });
    if (
      !run ||
      run.botId !== context.botId ||
      run.origin !== "routine" ||
      run.channelId !== context.channelId ||
      !["running"].includes(run.status)
    ) {
      throw new ApiError(
        403,
        "wake_parent_unavailable",
        "WakeParent is available only in an active automation"
      );
    }
    const rootId = automationContextRunId(run.id, run.inboxEvents[0]?.payload);
    const root = await tx.run.findFirst({
      where: { id: rootId, botId: run.botId, origin: "routine", channelId: run.channelId },
    });
    if (!root)
      throw new ApiError(
        403,
        "wake_parent_unavailable",
        "Automation context does not belong to this run"
      );
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`automation-result:${rootId}`}))`;
    // The caller stops the background work these runs started.
    const automation_run_ids = (await tx.run.findMany({
      where: {
        botId: run.botId,
        channelId: run.channelId,
        origin: "routine",
        OR: [{ id: rootId }, { inboxEvents: { some: { payload: { path: ["automationContextRunId"], equals: rootId } } } }],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    })).map((entry) => entry.id);
    const existing = await tx.automationResult.findUnique({ where: { runId: rootId } });
    if (existing?.wakeRunId) return { woken: true, run_id: existing.wakeRunId, automation_run_ids };
    const wake = await messaging.enqueueWake(tx, {
      botId: run.botId,
      channelId: context.channelId,
      origin: "background_revival",
      type: "automation.wake_parent",
      content: renderAutomationHandoffPrompt(input.message),
      handoff: input.message,
      clientId: `automation:${rootId}:wake-parent`,
      priority: 260,
    });
    await tx.automationResult.upsert({
      where: { runId: rootId },
      create: { runId: rootId, message: input.message, wakeRunId: wake.run.id },
      update: { message: input.message, wakeRunId: wake.run.id },
    });
    return { woken: true, run_id: wake.run.id, automation_run_ids };
  });
}

/** Saving a final result never starts a parent turn. Explicit handoffs win. */
export async function saveSilentAutomationResult(tx: Prisma.TransactionClient, runId: string) {
  const run = await tx.run.findUnique({
    where: { id: runId },
    include: { inboxEvents: { take: 1, select: { payload: true } } },
  });
  if (!run || run.origin !== "routine") return;
  const rootId = automationContextRunId(run.id, run.inboxEvents[0]?.payload);
  if (
    !(await tx.run.findFirst({
      where: { id: rootId, botId: run.botId, channelId: run.channelId, origin: "routine" },
    }))
  )
    return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`automation-result:${rootId}`}))`;
  if (
    (
      await tx.automationResult.findUnique({
        where: { runId: rootId },
        select: { wakeRunId: true },
      })
    )?.wakeRunId
  )
    return;
  const family = await tx.run.findMany({
    where: {
      botId: run.botId,
      channelId: run.channelId,
      origin: "routine",
      OR: [
        { id: rootId },
        {
          inboxEvents: { some: { payload: { path: ["automationContextRunId"], equals: rootId } } },
        },
      ],
    },
    select: { id: true, status: true },
  });
  if (
    family.some(
      (entry) =>
        entry.id !== runId && ["queued", "running"].includes(entry.status)
    )
  )
    return;
  const children = await tx.subagentAttempt.count({
    where: {
      parentRunId: { in: family.map((entry) => entry.id) },
      status: { in: ["provisioning", "queued", "running"] },
    },
  });
  if (children) return;
  if (
    await pendingAutomationShells(
      tx,
      run.botId,
      family.map((entry) => entry.id)
    )
  )
    return;
  // Event sequence preserves stream order even when several messages share a
  // millisecond timestamp. Sorting Message.updatedAt can select earlier prose.
  const final = await tx.event.findFirst({
    where: {
      entityId: runId,
      topic: "run_item.completed",
      payload: { path: ["item", "type"], equals: "agentMessage" },
    },
    orderBy: { sequence: "desc" },
    select: { payload: true },
  });
  const payload = final?.payload as { item?: { text?: unknown } } | undefined;
  const message = typeof payload?.item?.text === "string" ? payload.item.text.trim() : "";
  if (!message) return;
  await tx.automationResult.upsert({
    where: { runId: rootId },
    create: { runId: rootId, message },
    update: { message },
  });
}
