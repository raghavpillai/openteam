import type { PrismaClient } from "@openteam/db";
import type { HostReviewContext } from "@openteam/contracts/service-protocol";
import type { AutoReviewMessage } from "./auto-review-service";

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
        content: { not: "" },
      },
      orderBy: { sequence: "desc" },
      take: 40,
      select: { sender: true, content: true },
    });
    messages.push(
      ...rows
        .reverse()
        .map((row) => ({
          role: row.sender === "user" ? ("user" as const) : ("assistant" as const),
          content: row.content,
          source: "conversation" as const,
        }))
    );
  }
  // The persisted routine revision is the authorization, not the untrusted event
  // payload or the child's model-written task description.
  const execution = await db.routineExecution.findUnique({
    where: { runId: parent.id },
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
  return bounded.reverse();
}
