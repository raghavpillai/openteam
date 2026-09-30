import type { PrismaClient } from "@openteam/db";
import type { HostReviewContext } from "@openteam/contracts/service-protocol";
import type { AutoReviewMessage } from "./auto-review-service";
import { automationContextRunId } from "@openteam/messaging";
import { AssetRef } from "@openteam/contracts";
import { Schema } from "effect";

// Preserve action counts without forwarding typed text, clipboard contents,
// shell commands, or model-authored descriptions as review authority.
export function computerActionReceipt(content: unknown): Array<{ action: string; key?: string }> | undefined {
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const args = (content as { arguments?: unknown }).arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const first = args as Record<string, unknown>;
  const actions = [first, ...(Array.isArray(first.then) ? first.then : [])];
  return actions.slice(0, 64).flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const { action, key, modifiers } = value as Record<string, unknown>;
    if (typeof action !== "string" || !["click", "move", "drag", "scroll", "type", "key", "screenshot"].includes(action)) return [];
    const chord = typeof key === "string" ? (typeof modifiers === "string" ? `${modifiers}+${key}` : key) : "";
    // Only recognizable key chords; arbitrary strings can contain private input.
    const safeKey = /^(?:(?:ctrl|control|alt|shift|super|meta|cmd)\+)*(?:[a-z0-9]|F\d{1,2}|Return|Enter|Tab|Escape|BackSpace|Delete|Home|End|Left|Right|Up|Down|space|Page_Up|Page_Down)$/i.test(chord);
    return [{ action, ...(action === "key" && safeKey ? { key: chord } : {}) }];
  });
}

/** Resolve authority from persisted human messages, never caller-supplied transcripts. */
export async function loadAutoReviewContext(
  db: PrismaClient,
  context: HostReviewContext
): Promise<AutoReviewMessage[]> {
  const run = await db.run.findUnique({ where: { id: context.runId } });
  if (!run || run.botId !== context.botId || !["running", "waiting_approval"].includes(run.status))
    throw new Error("Review run is no longer active");
  const child = await db.subagent.findUnique({ where: { childBotId: run.botId } });
  if (child && child.currentRunId !== run.id) throw new Error("Subagent review is stale");
  const parent = child ? await db.run.findUnique({ where: { id: child.parentRunId } }) : run;
  if (!parent || (child && parent.botId !== child.parentBotId))
    throw new Error("Review parent is unavailable");
  const channelId = child?.parentChannelId ?? parent.channelId;
  const botId = child?.parentBotId ?? parent.botId;
  const messages: AutoReviewMessage[] = [];
  // Label the persisted trigger instead of treating every historical task as
  // the current authorization. Keep history: enduring restrictions still apply.
  const parentInbox = await db.inboxEvent.findFirst({ where: { runId: parent.id }, select: { payload: true } });
  const taskContextRunId = (parentInbox?.payload as { taskContextRunId?: unknown } | undefined)?.taskContextRunId;
  const taskRun = typeof taskContextRunId === "string" ? await db.run.findFirst({ where: { id: taskContextRunId, botId, channelId } }) : parent;
  if (!taskRun) throw new Error("Review task context is unavailable");
  const delivery = taskRun.deliveryId ? await db.channelDelivery.findUnique({ where: { id: taskRun.deliveryId }, include: { round: true } }) : null;
  const inputMessage = await db.message.findUnique({ where: { id: taskRun.userMessageId }, select: { clientId: true } });
  const trigger = channelId ? await db.channelMessage.findFirst({ where: {
    channelId,
    ...(delivery ? { id: delivery.round.rootMessageId } : inputMessage?.clientId ? { clientId: inputMessage.clientId } : { id: taskRun.userMessageId }),
  }, select: { sequence: true } }) : null;
  if (channelId) {
    const visible = await db.channel.findFirst({
      where: { id: channelId, archivedAt: null, members: { some: { botId } } },
      select: { id: true },
    });
    if (!visible) throw new Error("Review conversation is unavailable");
    const rows = await db.channelMessage.findMany({
      where: {
        channelId,
        OR: [
          { sender: "user", senderBotId: null, sourceRunId: null },
          { sender: "agent", senderBotId: botId },
        ],
      },
      orderBy: { sequence: "desc" },
      take: 40,
      select: { sender: true, content: true, sequence: true, metadata: true },
    });
    messages.push(
      ...rows
        .reverse()
        .flatMap((row): AutoReviewMessage[] => {
          const taskPhase = trigger ? row.sequence < trigger.sequence ? "prior" : row.sequence === trigger.sequence ? "current" : "followup" : undefined;
          const entries: AutoReviewMessage[] = row.content ? [{
          role: row.sender === "user" ? ("user" as const) : ("assistant" as const),
          content: row.content,
          source: "conversation" as const,
          ...(taskPhase ? { taskPhase } : {}),
          }] : [];
          // Only human-message upload records, not agent assertions, tool output,
          // arbitrary metadata, or attachment contents. Names are data, not authority.
          const refs = (row.metadata as { attachments?: unknown } | null)?.attachments;
          if (row.sender === "user" && Array.isArray(refs)) {
            const attachments = refs.filter(Schema.is(AssetRef)).map(ref => ({
              assetId: ref.assetId, fileName: ref.fileName, byteSize: ref.byteSize, mimeType: ref.mimeType,
            }));
            if (attachments.length) entries.push({ role: "assistant", source: "attachment_metadata",
              content: JSON.stringify({ uploadedAttachments: attachments }), ...(taskPhase ? { taskPhase } : {}) });
          }
          return entries;
        })
    );
  }
  // The persisted routine revision is the authorization, not the untrusted event
  // payload or the child's model-written task description.
  let authorizationRunId = parent.id;
  if (parent.origin === "routine") {
    const event = await db.inboxEvent.findFirst({ where: { runId: parent.id }, select: { payload: true } });
    const rootId = automationContextRunId(parent.id, event?.payload);
    const root = await db.run.findFirst({ where: { id: rootId, botId: parent.botId, channelId: parent.channelId, origin: "routine" } });
    if (!root) throw new Error("Review automation context is unavailable");
    authorizationRunId = root.id;
  }
  const execution = await db.routineExecution.findUnique({
    where: delivery ? { channelMessageId: delivery.round.rootMessageId } : { runId: authorizationRunId },
    include: { routineRevision: true },
  });
  if (execution)
    messages.push({ role: "user", content: execution.routineRevision.prompt, source: "routine" });
  let remaining = 32_000;
  const bounded: AutoReviewMessage[] = [];
  for (const message of messages.toReversed()) {
    if (remaining <= 0) break;
    // Never present an authorization with its limiting clause silently removed.
    // An overlong message becomes unavailable, rather than partial permission.
    const content =
      message.content.length > Math.min(remaining, 12_000)
        ? "[Message omitted because it exceeds the review context limit. Do not infer authorization from this omission.]"
        : message.content;
    remaining -= content.length;
    bounded.push({ ...message, content });
  }
  // Keep factual call receipts separate from human authorization. Never include
  // arbitrary tool output or arguments: those may contain secrets or page instructions.
  const receiptRunIds = [...new Set([run.id, parent.id, taskRun.id])];
  const receipts = await db.runItem.findMany({
    where: {runId: {in: receiptRunIds}, kind: {in: ["tool", "command"]}, status: {in: ["completed", "failed"]},
      OR: [{ title: null }, { title: { not: "promptFingerprint" } }]},
    orderBy: {createdAt: "desc"}, take: 12,
    select: {runId: true, kind: true, status: true, title: true, content: true},
  });
  const declined = await db.approval.findMany({
    where: { runId: { in: receiptRunIds }, status: "declined" },
    orderBy: { createdAt: "desc" }, take: 8,
    select: { decision: true, details: true },
  });
  // Immutable attempt lifecycle is evidence of execution, not proof that a
  // model-authored verdict is correct. Never forward worker prompts/results as
  // authorization or infer completion from inbox prose. Retain attempts even
  // if that worker has since been resumed for another run.
  const attempts = await db.subagentAttempt.findMany({
    where: { parentRunId: { in: [...new Set([parent.id, taskRun.id])] },
      ...(channelId ? { parentChannelId: channelId } : {}), subagent: { parentBotId: botId } },
    orderBy: { createdAt: "desc" }, take: 12,
    select: { id: true, subagentId: true, childRunId: true, parentRunId: true,
      status: true, startedAt: true, completedAt: true, stoppedAt: true },
  });
  const result = bounded.reverse();
  // The actor is a server-verified relationship, not an assistant's claim that
  // it delegated. Do not include the model-written worker prompt as authority.
  result.push({ role: "assistant", source: "execution_context", content: JSON.stringify({
    actingAgent: child ? "delegated_worker" : "conversation_agent",
    runId: run.id,
    taskRunId: taskRun.id,
    taskRunCreatedAt: taskRun.createdAt,
    parentRunId: child ? parent.id : null,
    workerType: child?.subagentType ?? null,
    readOnlyWorker: child?.readOnly === true,
  }) });
  if (attempts.length) result.push({ role: "assistant", source: "execution_receipt", content: JSON.stringify({
    workerLifecycle: attempts.reverse().map(row => ({ attemptId: row.id, subagentId: row.subagentId,
      childRunId: row.childRunId, parentRunId: row.parentRunId, status: row.status,
      startedAt: row.startedAt, completedAt: row.completedAt, stoppedAt: row.stoppedAt })),
  }) });
  if (receipts.length) result.push({role: "assistant", source: "execution_receipt", content: JSON.stringify(receipts.reverse().map(row => ({runId: row.runId, kind: row.kind, status: row.status, tool: row.kind === "command" ? "Shell" : row.title?.slice(0, 120), ...(row.title === "Computer" ? { actions: computerActionReceipt(row.content) } : {})})))});
  if (declined.length) result.push({ role: "assistant", source: "execution_receipt", content: JSON.stringify({
    priorDeclinedReviews: declined.reverse().map(row => {
      const details = row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details as Record<string, unknown> : {};
      return { decision: row.decision,
        tool: typeof details.toolName === "string" ? details.toolName.slice(0, 120) : undefined,
        reason: typeof details.reason === "string" ? details.reason.slice(0, 2_000) : undefined };
    }),
  }) });
  return result;
}
