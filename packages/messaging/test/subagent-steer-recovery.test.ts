import { expect, test } from "bun:test";
import { AgentMessaging } from "../src/index";

test("a worker steer its turn never took fails instead of becoming a new turn", async () => {
  const updates: any[] = [];
  const tx: any = { inboxEvent: { updateMany: async (query: any) => (updates.push(query), { count: 1 }) } };
  const messaging: any = Object.create(AgentMessaging.prototype);
  expect(await messaging.failUndeliveredSteers(tx, { runId: "old-run" }, "run_settled")).toBe(1);
  expect(updates[0].where).toEqual({ runId: "old-run", deliveryMode: "steer", status: { in: ["pending", "processing"] } });
  expect(updates[0].data.status).toBe("failed");
  expect(updates[0].data.error).toEqual({ code: "subagent_steer_target_ended", reason: "run_settled" });
});
