import { expect, test } from "bun:test";
import { createOpenTeamClient } from "../src";

test("routine creation preserves a supplied retry nonce and defaults other callers to fresh IDs", async () => {
  const calls: unknown[] = [];
  let nonce = 0;
  const client = createOpenTeamClient({
    baseUrl: "http://fixture",
    createId: () => `generated-${++nonce}`,
    fetch: (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({});
    }) as typeof fetch,
  });
  const input = { name: "Audit", prompt: "Inspect", schedule: "@every 1h", enabled: true };
  await client.createRoutine("bot", "bot", input, "stable-create");
  await client.createRoutine("bot", "bot", input, "stable-create");
  await client.createRoutine("bot", "bot", input);
  expect(calls).toEqual([
    { ...input, clientId: "stable-create" },
    { ...input, clientId: "stable-create" },
    { ...input, clientId: "generated-1" },
  ]);
});
