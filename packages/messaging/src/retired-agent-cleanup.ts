import type { PrismaClient } from "@openteam/db";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import type { AgentDataStore } from "./agent-data";

export const RETIRED_AGENT_CLEANUP_RETRY_MS = 30_000;
type ComputerFetch = (path: string, init: RequestInit) => Promise<Response>;
type AgentFiles = Pick<AgentDataStore, "deleteAgentFiles" | "repairActiveAgentAfterDeletion">;

/** Idempotent cleanup shared by the API's first attempt and the worker's durable retry queue. */
export async function cleanupRetiredAgent(
  prisma: PrismaClient,
  computerFetch: ComputerFetch,
  agentData: AgentFiles | undefined,
  id: string
): Promise<string[]> {
  const retired = await prisma.retiredAgent.findUnique({ where: { id } });
  if (!retired?.cleanupPending) return [];
  const warnings: string[] = [];
  const attempt = async (label: string, work: () => Promise<void>) => {
    try { await work(); }
    catch (error) { warnings.push(`${label}: ${String(error)}`); }
  };
  const request = async (path: string, method: string, body?: unknown, inactiveTurnIsSuccess = false) => {
    const response = await computerFetch(path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return;
    const message = await response.text();
    if (inactiveTurnIsSuccess && response.status === 400 && message.includes("Run is not actively executing")) return;
    throw new Error(`${response.status} ${message}`);
  };
  await Promise.all(retired.cleanupRunIds.map((runId) => attempt(`turn ${runId}`, () =>
    request(COMPUTER_API_PATHS.turnCancel(runId), "POST", { reason: "stop", recovery: true }, true)
  )));
  const contexts = await prisma.contextSession.findMany({
    where: { OR: [{ botId: id }, { scope: "channel", scopeId: id }] },
    select: { id: true, runtimeSessionPath: true },
  });
  await Promise.all(contexts.map((context) => attempt(`context session ${context.id}`, async () => {
    await request(`/v1/context-sessions/${context.id}`, "DELETE", { sessionPath: context.runtimeSessionPath });
    // Keep bookkeeping until the runtime has released the context and discarded its file.
    await prisma.contextSession.deleteMany({ where: { id: context.id } });
  })));
  await attempt(`background commands ${id}`, () => request(COMPUTER_API_PATHS.backgroundShellsStop(id), "POST"));
  await attempt(`screen ${id}`, () => request(`/v1/screens/${id}`, "DELETE"));
  // Close store handles and remove the directory from roster discovery before deleting shared files.
  await attempt(`agent store ${id}`, () => request(COMPUTER_API_PATHS.agentStore(id), "DELETE"));
  if (agentData) {
    await attempt(`agent files ${id}`, () => agentData.deleteAgentFiles(id));
    await attempt(`active agent repair ${id}`, () => agentData.repairActiveAgentAfterDeletion(id).then(() => {}));
  }
  await prisma.retiredAgent.update({
    where: { id },
    data: {
      cleanupPending: warnings.length > 0,
      nextCleanupAt: new Date(Date.now() + RETIRED_AGENT_CLEANUP_RETRY_MS),
    },
  });
  return warnings;
}
