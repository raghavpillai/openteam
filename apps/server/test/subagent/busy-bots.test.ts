import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SubagentService } from "../../src/services/subagent/service";

function service(runs: Array<{ id: string; botId: string; status: string }>, subagents: Array<{ parentBotId: string; childBotId: string; status: string }>) {
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]: any) =>
    value && typeof value === "object" && "in" in value ? value.in.includes(row[key]) : row[key] === value);
  const names: Record<string, string> = { chief: "Chief of Staff", scout: "Scout", worker: "worker", nested: "nested" };
  const db: any = {
    run: { findMany: async ({ where }: any) => runs.filter((row) => matches(row, where)) },
    subagent: { findMany: async ({ where }: any) => subagents.filter((row) => matches(row, where)) },
    bot: { findMany: async ({ where }: any) => where.id.in.map((id: string) => ({ id, name: names[id] })) },
  };
  return new SubagentService(db, {} as never, {} as never, "/workspace", (async () => new Response()) as never, {} as never);
}

test("an idle install has no busy bots", async () => {
  const result = await Effect.runPromise(service([{ id: "done", botId: "chief", status: "completed" }], []).busyBots());
  expect(result).toEqual({ bots: [] });
});

test("subagent work, however deep, counts for the bot that launched it", async () => {
  const result = await Effect.runPromise(service(
    [
      { id: "scout-turn", botId: "scout", status: "queued" },
      { id: "worker-turn", botId: "worker", status: "running" },
      { id: "nested-turn", botId: "nested", status: "running" },
    ],
    [
      { parentBotId: "chief", childBotId: "worker", status: "running" },
      { parentBotId: "worker", childBotId: "nested", status: "running" },
    ],
  ).busyBots());
  expect(result).toEqual({
    bots: [
      { botId: "scout", name: "Scout", runIds: ["scout-turn"] },
      { botId: "chief", name: "Chief of Staff", runIds: ["worker-turn", "nested-turn"] },
    ],
  });
});

test("a subagent still starting up keeps its bot busy", async () => {
  const result = await Effect.runPromise(service([], [{ parentBotId: "chief", childBotId: "worker", status: "provisioning" }]).busyBots());
  expect(result).toEqual({ bots: [{ botId: "chief", name: "Chief of Staff", runIds: [] }] });
});
