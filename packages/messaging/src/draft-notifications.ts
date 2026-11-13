import { createHash } from "node:crypto";
import { Prisma } from "@openteam/db";
import { nextMessageAddress } from "./message-address";
import { publishMessageNotification, refreshMessageNotification } from "./notifications";
import type { AgentSendToUserInput } from "@openteam/contracts";

export const DRAFT_NOTIFICATION_COLLECTION_MS = 300;
export const DRAFT_NOTIFICATION_PROGRESS_IDLE_MS = 10_000;
export type DraftNotificationVariant = "control" | "treatment";
type DB = Prisma.TransactionClient;
const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** Opt-in only. Cohorts are stable by bot; a pending outcome keeps its recorded variant. */
export function draftNotificationVariant(botId: string, configured = process.env.OPENTEAM_DRAFT_NOTIFICATION_TREATMENT_PERCENT): DraftNotificationVariant {
  const percent = configured === undefined ? 0 : Number(configured);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return "control";
  const bucket = createHash("sha256").update(`draft-notifications-v1:${botId}`).digest().readUInt32BE(0) / 2 ** 32 * 100;
  return bucket < percent ? "treatment" : "control";
}

export function isTreatmentDraftWake(wake: { type: string; payload: unknown }) {
  return wake.type === "draft.response" && object(object(wake.payload).draftNotification).variant === "treatment";
}

/** Reuse a receipt only for the identical text with no additional content or routing. */
export function isExactDraftNotificationEcho(input: AgentSendToUserInput, content: string) {
  return input.type === "text" && input.content === content && Object.entries(input).every(
    ([key, value]) => value === undefined || ["type", "content", "end_turn"].includes(key)
  );
}

export async function lockDraftNotifications(tx: DB, botId: string, channelId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`draft-notification:${botId}:${channelId}`}))`;
}

type Outcome = { id: string; metadata: Prisma.JsonValue };
export async function pendingDraftNotifications(tx: DB, botId: string, channelId: string): Promise<Outcome[]> {
  return tx.$queryRaw<Outcome[]>`SELECT "id", jsonb_build_object(
      'outcomeId', "metadata"->'outcomeId', 'cardState', "metadata"->'cardState',
      'draftNotification', "metadata"->'draftNotification', 'draft', jsonb_build_object(
        'platform', "metadata"#>'{draft,platform}', 'to', "metadata"#>'{draft,to}',
        'target', "metadata"#>'{draft,target}', 'subject', "metadata"#>'{draft,subject}')) AS "metadata"
    FROM "ChannelMessage"
    WHERE "senderBotId" = ${botId}::uuid AND "channelId" = ${channelId}::uuid
      AND "metadata"->>'type' = 'external-draft' AND "metadata" ? 'outcomeId'
      AND "metadata"#>>'{draftNotification,variant}' = 'treatment'
      AND "metadata"#>>'{draftNotification,messageId}' IS NULL
    ORDER BY "sequence"`;
}

/** Freeze identities in the durable inbox payload, independently of prompt-delivery receipts. */
export async function prepareDraftNotification(tx: DB, wake: { id: string; botId: string; status: string; payload: unknown; run: { channelId: string | null } }) {
  if (!wake.run.channelId) return null;
  await lockDraftNotifications(tx, wake.botId, wake.run.channelId);
  const payload = object(wake.payload);
  const previous = object(payload.draftNotification);
  const rows = await pendingDraftNotifications(tx, wake.botId, wake.run.channelId);
  if (!rows.length && wake.status === "pending") return null;
  // A queued replay may have absorbed new outcomes. Rebind it at claim; only an
  // already-processing turn keeps its original snapshot across lease recovery.
  const outcomeIds = wake.status === "processing" && Array.isArray(previous.outcomeIds)
    ? previous.outcomeIds : rows.map(row => String(object(row.metadata).outcomeId));
  const content = `[SAND_HIDDEN_PROMPT]The platform handles the status acknowledgement for these draft outcomes. Do not post another status confirmation or infer other cards are pending. Complete the user's remaining requests using the individual card outcomes and the platform's stored-state counts, including any requested follow-up question. Questions, warnings, errors, and other useful new information must be delivered by actually calling SendToUser; plain assistant text is not shown to the user. If only acknowledging settled drafts remains, finish silently; you do not owe an additional acknowledgement.\n${rows.map(row => `Draft card ID: ${row.id}; outcome: ${object(row.metadata).outcomeId}; state: ${object(row.metadata).cardState}`).join("\n")}`;
  const next = { ...payload, content, draftNotification: { variant: "treatment", outcomeIds } };
  await tx.inboxEvent.update({ where: { id: wake.id }, data: { payload: next as Prisma.InputJsonValue } });
  if (typeof payload.messageId === "string") await tx.message.update({ where: { id: payload.messageId }, data: { content } });
  return { ...wake, payload: next };
}

type Counts = Record<"sent" | "dismissed" | "pending" | "sending" | "unknown" | "failed", number>;
/** Current card identities and delivery states for a draft-outcome turn. */
export async function draftReplySnapshot(tx: DB, context: Pick<DraftNotificationContext, "botId" | "channelId">) {
  const cards = await tx.$queryRaw<Array<{ id: string; state: string; outcomeId: string | null }>>`SELECT
    "id", coalesce("metadata"->>'cardState', 'pending') AS "state", "metadata"->>'outcomeId' AS "outcomeId"
    FROM "ChannelMessage" WHERE "channelId" = ${context.channelId}::uuid AND "senderBotId" = ${context.botId}::uuid
      AND "metadata"->>'type' = 'external-draft' ORDER BY "id"`;
  const totals = counts([]);
  for (const card of cards) totals[Object.hasOwn(totals, card.state) ? card.state as keyof Counts : "failed"]++;
  return { revision: createHash("sha256").update(JSON.stringify(cards)).digest("hex"), counts: totals, cards };
}

/** Never report success for text based on a superseded snapshot. The next response can retry useful information. */
export async function guardDraftReply(tx: DB, context: DraftNotificationContext & { draftStateRevision?: string }) {
  if (!context.draftStateRevision) return null; // Older computers remain compatible during a rolling update.
  const event = await tx.inboxEvent.findFirst({ where: { runId: context.runId, botId: context.botId, type: "draft.response",
    run: { channelId: context.channelId, status: { in: ["queued", "running"] } } }, select: { id: true } });
  if (!event) return null;
  await lockDraftNotifications(tx, context.botId, context.channelId);
  const current = await draftReplySnapshot(tx, context);
  if (current.revision === context.draftStateRevision) return null;
  return {
    sent: false, delivery_failed: true, retryable: true, reason: "draft_state_changed",
    draft_state_revision: current.revision, draft_state: current.counts,
    cards: current.cards.slice(0, 50),
    note: "Nothing was delivered. Draft state changed while you were working. Reconsider this reply using these current counts; do not ask about remaining drafts when pending is zero. In your next response, actually call SendToUser again for any still-useful warning, question, or other requested information. Finish silently if only an obsolete draft question remains. Do not repeat successful draft or connector actions. Other sends already emitted in this response use the old snapshot too.",
  };
}

function counts(rows: Outcome[]): Counts {
  const result: Counts = { sent: 0, dismissed: 0, pending: 0, sending: 0, unknown: 0, failed: 0 };
  for (const row of rows) {
    const state = object(row.metadata).cardState ?? "pending";
    result[Object.hasOwn(result, state) ? state as keyof Counts : "failed"]++;
  }
  return result;
}
function summary(rows: Outcome[], batch: Counts) {
  const changed = counts(rows), first = object(rows[0]?.metadata), draft = object(first.draft);
  const label = rows.every(row => object(object(row.metadata).draft).platform === "email") ? "email draft" : "message draft";
  let text: string;
  if (rows.length === 1 && ["sent", "dismissed"].includes(first.cardState)) {
    const recipient = draft.platform === "email" ? (Array.isArray(draft.to) ? draft.to.join(", ") : "") : draft.target;
    const target = String(recipient ?? "").slice(0, 500);
    const subject = draft.platform === "email" ? ` (“${String(draft.subject ?? "").slice(0, 300)}”)` : "";
    text = first.cardState === "sent" ? `Sent the draft to ${target}${subject}.` : `Discarded the draft to ${target}${subject}. Nothing was sent for that draft.`;
  } else {
    const parts = [];
    if (changed.sent) parts.push(`${changed.sent} sent`);
    if (changed.dismissed) parts.push(`${changed.dismissed} discarded without sending`);
    if (changed.unknown) parts.push(`${changed.unknown} with unconfirmed delivery`);
    if (changed.failed) parts.push(`${changed.failed} not delivered`);
    text = `${rows.length} ${label}${rows.length === 1 ? "" : "s"} settled: ${parts.join(", ")}.`;
  }
  const status = [];
  status.push(batch.pending ? `${batch.pending} awaiting review` : "none awaiting review");
  if (batch.sending) status.push(`${batch.sending} still sending`);
  if (batch.unknown) status.push(`${batch.unknown} with unconfirmed delivery`);
  return `${text} Drafts in this chat: ${status.join(", ")}.`;
}

export interface DraftNotificationContext { botId: string; channelId: string; runId: string; timeZone?: string | null }
/** One visible row, its push outbox, and all per-outcome notification receipts commit together. */
export async function publishDraftNotification(tx: DB, context: DraftNotificationContext) {
  const event = await tx.inboxEvent.findFirst({ where: { runId: context.runId, botId: context.botId, type: "draft.response" }, include: { run: true } });
  if (!event || !isTreatmentDraftWake(event) || event.run.channelId !== context.channelId) return null;
  const quiet = { acknowledgement: { sent: false, silent: true }, interruptRunId: null };
  if (!["queued", "running"].includes(event.run.status)) return { result: quiet, created: false, updated: false };
  const channel = await tx.channel.findFirst({ where: { id: context.channelId, kind: "bot_dm", archivedAt: null,
    members: { some: { botId: context.botId, bot: { status: "active" } } } } });
  if (!channel) return { result: quiet, created: false, updated: false };
  await lockDraftNotifications(tx, context.botId, context.channelId);
  const clientId = `draft-notification:${context.runId}`;
  const existing = await tx.channelMessage.findUnique({ where: { channelId_clientId: { channelId: context.channelId, clientId } } });
  const acknowledgement = (message: { id: string; metadata: Prisma.JsonValue }, duplicate: boolean) => ({
    acknowledgement: { sent: true, message_id: message.id, message_address: object(message.metadata).address, duplicate }, interruptRunId: null,
  });
  if (existing) return { result: acknowledgement(existing, true), created: false, updated: false };
  const receipt = object(object(event.payload).draftNotification);
  const outcomeIds = Array.isArray(receipt.outcomeIds) ? receipt.outcomeIds.filter((id): id is string => typeof id === "string") : [];
  // A replay with a new run/tool-call ID must not consume a later, unrelated outcome.
  if (outcomeIds.length) {
    const covered = await tx.$queryRaw<Outcome[]>`SELECT "id", jsonb_build_object(
      'outcomeId', "metadata"->'outcomeId', 'draftNotification', "metadata"->'draftNotification') AS "metadata" FROM "ChannelMessage"
      WHERE "channelId" = ${context.channelId}::uuid AND "senderBotId" = ${context.botId}::uuid
      AND "metadata"->>'outcomeId' IN (${Prisma.join(outcomeIds)})`;
    if (!covered.some(row => !object(object(row.metadata).draftNotification).messageId)) {
      const id = covered.map(row => object(object(row.metadata).draftNotification).messageId).find(id => typeof id === "string");
      const previous = id ? await tx.channelMessage.findFirst({ where: { id, channelId: context.channelId, senderBotId: context.botId } }) : null;
      return { result: previous ? acknowledgement(previous, true) : quiet, created: false, updated: false };
    }
  }
  const rows = await pendingDraftNotifications(tx, context.botId, context.channelId);
  if (!rows.length) return { result: quiet, created: false, updated: false };
  const totals = await tx.$queryRaw<Array<{ state: string; count: bigint }>>`SELECT
    coalesce("metadata"->>'cardState', 'pending') AS "state", count(*) AS "count" FROM "ChannelMessage"
    WHERE "channelId" = ${context.channelId}::uuid AND "senderBotId" = ${context.botId}::uuid
      AND "metadata"->>'type' = 'external-draft' GROUP BY 1`;
  const batchCounts = counts([]);
  for (const row of totals) batchCounts[Object.hasOwn(batchCounts, row.state) ? row.state as keyof Counts : "failed"] += Number(row.count);
  // Consecutive progress stays in one row. A new chat message or an idle pause starts a new acknowledgement.
  const last = await tx.channelMessage.findFirst({ where: { channelId: context.channelId }, orderBy: { sequence: "desc" } });
  const prior = object(object(last?.metadata).draftOutcomeNotification);
  const progressAt = Date.parse(String(prior.updatedAt ?? last?.createdAt.toISOString() ?? ""));
  const reuse = last?.senderBotId === context.botId && prior.variant === "treatment" &&
    (object(prior.counts).pending > 0 || object(prior.counts).sending > 0) &&
    Date.now() >= progressAt && Date.now() - progressAt <= DRAFT_NOTIFICATION_PROGRESS_IDLE_MS &&
    Array.isArray(prior.outcomeIds) && prior.outcomeIds.length > 0;
  let combined = rows;
  if (reuse && prior.outcomeIds.length) {
    const previousRows = await tx.$queryRaw<Outcome[]>`SELECT "id", jsonb_build_object(
      'outcomeId', "metadata"->'outcomeId', 'cardState', "metadata"->'cardState', 'draft', jsonb_build_object(
        'platform', "metadata"#>'{draft,platform}', 'to', "metadata"#>'{draft,to}',
        'target', "metadata"#>'{draft,target}', 'subject', "metadata"#>'{draft,subject}')) AS "metadata"
      FROM "ChannelMessage" WHERE "channelId" = ${context.channelId}::uuid AND "senderBotId" = ${context.botId}::uuid
        AND "metadata"->>'outcomeId' IN (${Prisma.join(prior.outcomeIds)}) ORDER BY "sequence"`;
    combined = [...previousRows, ...rows];
  }
  const now = new Date().toISOString();
  const notification = { variant: "treatment", outcomeIds: combined.map(row => String(object(row.metadata).outcomeId)),
    counts: batchCounts, changed: counts(combined), updatedAt: now };
  const message = reuse ? await tx.channelMessage.update({ where: { id: last.id }, data: {
    content: summary(combined, batchCounts), metadata: { ...object(last.metadata), draftOutcomeNotification: notification },
  } }) : await tx.channelMessage.create({ data: {
    channelId: context.channelId, sender: "agent", senderBotId: context.botId, sourceRunId: context.runId,
    clientId, content: summary(rows, batchCounts), metadata: { kind: "send-message", type: "text",
      address: await nextMessageAddress(tx, context.channelId, "agent"), timeZone: context.timeZone ?? object(event.payload).timeZone ?? "UTC",
      draftOutcomeNotification: notification },
  } });
  await tx.$executeRaw`UPDATE "ChannelMessage" SET "metadata" = "metadata" || jsonb_build_object(
    'draftNotification', coalesce("metadata"->'draftNotification', '{}'::jsonb) || jsonb_build_object('messageId', ${message.id}::text, 'notifiedAt', ${now}::text))
    WHERE "id" IN (${Prisma.join(rows.map(row => Prisma.sql`${row.id}::uuid`))})`;
  if (reuse) {
    await refreshMessageNotification(tx, message);
    await tx.event.create({ data: { topic: "channel.message.updated", entityId: message.id,
      payload: { channelId: context.channelId, messageId: message.id } } });
  } else await publishMessageNotification(tx, message);
  await tx.channel.update({ where: { id: context.channelId }, data: { updatedAt: new Date() } });
  await tx.event.create({ data: { topic: "draft.notification.published", entityId: message.id,
    payload: { variant: "treatment", botId: context.botId, channelId: context.channelId, outcomeCount: rows.length,
      runId: context.runId, updated: Boolean(reuse) } } });
  return { result: acknowledgement(message, false), created: !reuse, updated: Boolean(reuse) };
}
