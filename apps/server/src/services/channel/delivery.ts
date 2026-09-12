import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import type { PrismaClient } from "@openteam/db";
import { appendEvent, type ComputerFetch } from "../service-utils";

export async function cancelSkippedBootstrap(
  computerFetch: ComputerFetch,
  prisma: PrismaClient,
  runId: string
): Promise<void> {
  try {
    const response = await computerFetch(COMPUTER_API_PATHS.turnCancel(runId), {
      method: "POST",
    });
    if (!response.ok) return;
    await prisma.$transaction((tx) =>
      appendEvent(tx, "bot.bootstrap.cancel_requested", runId, { runId })
    );
  } catch {
    // The durable user wake remains queued; a bootstrap that already ended cannot block it.
  }
}
