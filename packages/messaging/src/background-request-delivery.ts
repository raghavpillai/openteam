import { ApiError } from "@openteam/contracts";
import type { Prisma } from "@openteam/db";
import type { ToolContext } from "./index";
import { requestIsStopped } from "./request-state";

/** A completion may already be running when Stop's transport cancellation fails.
 * Serialize publication with Stop, rather than relying only on wake claim time.
 * Fresh user turns remain able to acknowledge Stop or start independent work. */
export async function assertBackgroundRequestDeliveryAllowed(
  tx: Prisma.TransactionClient,
  context: Pick<ToolContext, "botId" | "runId" | "origin">
) {
  if (context.origin !== "background_revival") return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bot-run-claim:${context.botId}`}))`;
  const source = await tx.run.findUnique({
    where: { id: context.runId },
    select: {
      botId: true,
      inboxEvents: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { payload: true, type: true },
      },
    },
  });
  if (source?.botId !== context.botId)
    throw new ApiError(409, "tool_context_invalid", "Dynamic tool context is not active");
  const requestId = (source.inboxEvents[0]?.payload as { taskContextRunId?: unknown } | null)
    ?.taskContextRunId;
  // A routine handoff is linked by its durable result receipt, independently
  // of foreground task progress. Stop may arrive after the parent was claimed.
  const handoff = source.inboxEvents.some((event) => event.type === "automation.wake_parent")
    ? await tx.automationResult.findUnique({
        where: { wakeRunId: context.runId },
        select: { runId: true },
      })
    : null;
  for (const id of new Set(
    [requestId, handoff?.runId].filter((id): id is string => typeof id === "string")
  )) {
    const root = await tx.run.findUnique({
      where: { id },
      select: { botId: true, status: true, requestStoppedAt: true, error: true },
    });
    if (root?.botId === context.botId && requestIsStopped(root))
      throw new ApiError(
        409,
        "request_stopped",
        "This request was stopped; its background result was not delivered."
      );
  }
}
