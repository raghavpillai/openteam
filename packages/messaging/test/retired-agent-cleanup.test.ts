import { expect, test } from "bun:test";
import { cleanupRetiredAgent } from "../src/retired-agent-cleanup";

for (const failure of ["turn", "context", "background", "screen", "store", "files"] as const) {
  test(`retired cleanup retries ${failure} after the directory is already gone`, async () => {
    const retired = { id: "bot", cleanupPending: true, cleanupRunIds: ["run"] };
    let contextExists = true;
    let offline = true;
    const calls: string[] = [];
    const prisma: any = {
      retiredAgent: { findUnique: async () => retired, update: async ({ data }: any) => Object.assign(retired, data) },
      contextSession: { findMany: async () => contextExists ? [{ id: "context", runtimeSessionPath: null }] : [], deleteMany: async () => { contextExists = false; } },
    };
    const computerFetch = async (path: string) => {
      calls.push(path);
      const fails = (failure === "turn" && path.endsWith("/cancel")) ||
        (failure === "context" && path.includes("context-sessions")) ||
        (failure === "background" && path.includes("background-shells")) ||
        (failure === "screen" && path.includes("screens")) ||
        (failure === "store" && path.includes("agent-stores"));
      if (offline && fails) return new Response("offline", { status: 503 });
      // Cancellation is idempotent even after the computer has already stopped the turn.
      if (path.endsWith("/cancel")) return new Response("Run is not actively executing", { status: 400 });
      return Response.json({ ok: true, removed: false });
    };
    const files = {
      deleteAgentFiles: async () => { if (offline && failure === "files") throw new Error("disk unavailable"); },
      repairActiveAgentAfterDeletion: async () => null,
    };
    expect(await cleanupRetiredAgent(prisma, computerFetch, files, "bot")).toHaveLength(1);
    expect(retired.cleanupPending).toBe(true);
    expect(contextExists).toBe(failure === "context");
    offline = false;
    expect(await cleanupRetiredAgent(prisma, computerFetch, files, "bot")).toEqual([]);
    expect(retired.cleanupPending).toBe(false);
    expect(contextExists).toBe(false);
    const completedCalls = calls.length;
    await cleanupRetiredAgent(prisma, computerFetch, files, "bot");
    expect(calls).toHaveLength(completedCalls);
  });
}
