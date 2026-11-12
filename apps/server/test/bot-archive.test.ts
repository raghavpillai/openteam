import { expect, test } from "bun:test";
import { Effect } from "effect";
import { BotService } from "../src/services/bot-service";

const fixture = (failure?: "context-network" | "screen-network" | "active-context" | "cancel-network" | "background-network") => {
  let status = "active";
  let runStatus = "running";
  let contextExists = true;
  let runtimeActive = true;
  const retired: string[] = [];
  let retirement: any = null;
  const calls: string[] = [];
  const observations: Array<{ status: string; runStatus: string; retired: string[] }> = [];
  let cancelBody: unknown;
  let contextWasActive: boolean | undefined;
  const tx = {
    $executeRaw: async () => 0,
    run: {
      findMany: async ({ where }: any) => where.requestStoppedAt === null ? [] : [{ id: "parent-run", botId: "bot", inboxEvents: [] }],
      updateMany: async ({ data }: any) => { runStatus = data.status; },
    },
    bot: {
      findUnique: async () => ({ id: "bot", status, subagentIdentity: null }),
      updateMany: async () => ({ count: 0 }),
      update: async () => { status = "archived"; },
    },
    subagent: { findMany: async () => [] },
    contextSession: {
      findMany: async () => contextExists ? [{ id: "context", runtimeSessionPath: "/sessions/x.jsonl" }] : [],
      deleteMany: async () => { contextExists = false; },
    },
    inboxEvent: { updateMany: async () => ({ count: 1 }) },
    routine: { updateMany: async () => ({ count: 0 }) },
    channel: { updateMany: async () => ({ count: 0 }) },
    event: { create: async () => ({}) },
    retiredAgent: {
      upsert: async ({ create }: any) => { retired.push(create.id); retirement = { cleanupPending: true, ...create }; },
      findUnique: async () => retirement,
      update: async ({ data }: any) => { Object.assign(retirement, data); },
    },
  };
  const prisma = { ...tx, $transaction: async (work: any) => work(tx) };
  const service = new BotService(prisma as never, {} as never, "/unused", async (path, init) => {
    calls.push(path);
    observations.push({ status, runStatus, retired: [...retired] });
    if (path.endsWith("/cancel")) {
      cancelBody = JSON.parse(String(init.body));
      if (failure === "cancel-network") throw new TypeError("fetch failed");
      runtimeActive = false;
    }
    if (path.includes("context-sessions")) {
      contextWasActive = runtimeActive;
      if (failure === "context-network") throw new TypeError("fetch failed");
      if (failure === "active-context" || runtimeActive) return new Response("Cannot delete an active context session", { status: 500 });
    }
    if (path.includes("background-shells") && failure === "background-network") throw new TypeError("fetch failed");
    if (path.includes("screens") && failure === "screen-network") throw new DOMException("timed out", "TimeoutError");
    return Response.json({ ok: true });
  }, { deleteAgentFiles: async () => {}, repairActiveAgentAfterDeletion: async () => {} } as never);
  return { service, calls, observations, cancelBody: () => cancelBody, contextWasActive: () => contextWasActive,
    cleanupPending: () => retirement.cleanupPending,
    state: () => ({ status, runStatus, contextExists, runtimeActive }) };
};

test("archive durably cancels and settles the parent turn before deleting its context", async () => {
  const f = fixture();
  expect(await Effect.runPromise(f.service.archive("bot"))).toEqual({ ok: true });
  expect(f.calls).toContain("/v1/bots/bot/background-shells/stop");
  expect(f.cancelBody()).toEqual({ reason: "stop", recovery: true });
  expect(f.contextWasActive()).toBe(false);
  expect(f.observations.every((o) => o.status === "archived" && o.runStatus === "cancelled" && o.retired.includes("bot"))).toBe(true);
  expect(f.cleanupPending()).toBe(false);
  expect(f.state()).toEqual({ status: "archived", runStatus: "cancelled", contextExists: false, runtimeActive: false });
  expect(f.calls.indexOf("/v1/turns/parent-run/cancel")).toBeLessThan(f.calls.indexOf("/v1/context-sessions/context"));
});

for (const failure of ["context-network", "screen-network", "active-context", "cancel-network", "background-network"] as const) {
  test(`archive succeeds despite ${failure} and retains runtime-owned session bookkeeping`, async () => {
    const f = fixture(failure);
    expect(await Effect.runPromise(f.service.archive("bot"))).toEqual({ ok: true });
    expect(f.state()).toMatchObject({ status: "archived", runStatus: "cancelled", contextExists: !["screen-network", "background-network"].includes(failure) });
    expect(f.cleanupPending()).toBe(true);
    expect(f.calls).toContain("/v1/agent-stores/bot");
    expect(f.calls).toContain("/v1/screens/bot");
    expect(f.observations.every((o) => o.status === "archived" && o.runStatus === "cancelled" && o.retired.includes("bot"))).toBe(true);
  });
}
