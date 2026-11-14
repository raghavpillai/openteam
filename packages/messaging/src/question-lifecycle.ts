import { ApiError } from "@openteam/contracts";
import { Prisma } from "@openteam/db";
import { canonicalAgentId } from "./agent-lifecycle";

/** Order publication, normal messages, and card mutations in one conversation. */
export const lockQuestions = (tx: Prisma.TransactionClient, channelId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`questions:${canonicalAgentId(channelId)}`}))`;

export const questionScopeForReply = (
  fork: boolean | undefined,
  reply: { id: string; metadata: unknown } | null
): string | null => {
  if (!fork) return null;
  if (!reply) throw new ApiError(400, "fork_reply_required", "A fork needs a reply target");
  const metadata = (reply.metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.questionScopeId === "string" ? metadata.questionScopeId : reply.id;
};

/** Durable settlement: loading older history or reconnecting cannot revive a question.
 * This never touches approvals, drafts, secrets, forms, or computer handoffs.
 * Call with the channel question lock held, including before publishing a new card.
 */
export const dismissQuestions = async (
  tx: Prisma.TransactionClient,
  channelId: string,
  scopeId: string | null,
  reason: "moved-on" | "superseded",
  exceptId?: string
) => {
  const messages = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "ChannelMessage"
    SET "metadata" = "metadata" || ${JSON.stringify({
      widgetDismissed: true,
      widgetDismissalReason: reason,
    })}::jsonb
    WHERE "channelId" = ${channelId}::uuid
      AND "sender" = 'agent'::"ChannelMessageSender"
      AND "metadata"->>'type' = 'widget'
      AND "metadata"->>'respondedValue' IS NULL
      AND coalesce(("metadata"->>'widgetDismissed')::boolean, false) = false
      AND coalesce("metadata"->>'questionScopeId', '') = ${scopeId ?? ""}
      AND coalesce(("metadata"->>'branched')::boolean, false) = ${scopeId !== null}
      ${exceptId ? Prisma.sql`AND "id" <> ${exceptId}::uuid` : Prisma.empty}
    RETURNING "id"
  `);
  if (messages.length) {
    await tx.event.createMany({
      data: messages.map((message) => ({
        topic: "channel.message.updated",
        entityId: message.id,
        payload: { channelId, messageId: message.id, reason: "widget-dismissed" },
      })),
    });
  }
  return messages;
};
