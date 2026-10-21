import { expect, test } from "bun:test";
import { SubagentService } from "../../src/services/subagent/service";
import { hashRequest } from "../../src/services/service-utils";

const NOT_RUNNING =
  'No subagent "sand-subagent-gone" is currently running. It may have already finished (you\'re revived automatically with a finished subagent\'s result), or the id is wrong. Currently running: sand-subagent-busy.';

/** A Task call whose attempt was already accepted, so task() only renders its result. */
const accepted = (input: Record<string, unknown>) => {
  const db: any = {
    subagent: { findUnique: async () => null },
    idempotencyRecord: { findUnique: async () => ({ requestHash: hashRequest(input), response: { subagentId: "child" } }) },
  };
  const service = new SubagentService(db, null as never, null as never, "/workspace", null as never, null as never) as any;
  service.attemptForCall = async () => ({ id: "attempt", subagentId: "child", status: "running", runInBackground: true });
  service.owned = async () => ({ id: "child" });
  return service.task({ botId: "parent", callId: "call" }, input);
};

test("a dispatch whose prompt names a tool the child lacks carries the reminder after its Agent ID", async () => {
  const result: string = await accepted({ description: "Flights", prompt: "Find flights, then SendToUser the cheapest.", subagent_type: "executor" });
  expect(result).toStartWith("Subagent is running in the background.");
  expect(result).toContain(
    "(can be used with the `resume` parameter to send a follow-up after it completes)\n\n<system_reminder>\nThis dispatch names SendToUser, which the executor subagent does not have, so it cannot do those steps.\n- SendToUser: Only the parent talks to the user; a Task subagent reports back in its final message.\n"
  );
  expect(result).toEndWith("</system_reminder>");
  expect(await accepted({ description: "Flights", prompt: "Find flights." })).not.toContain("<system_reminder>");
  const resumed: string = await accepted({ description: "Flights", prompt: "Now UpdateMemory with the airline.", resume: "sand-subagent-child" });
  expect(resumed).toContain("This dispatch names UpdateMemory, which the resumed subagent does not have");
});

test("a foreground Task returns the subagent's output, or its failure as Error", async () => {
  const run = (status: string, extra: Record<string, unknown> = {}) => {
    const input = { description: "Flights", prompt: "Find flights and SendToUser them.", subagent_type: "executor", run_in_background: false };
    const db: any = {
      subagent: { findUnique: async () => null },
      idempotencyRecord: { findUnique: async () => ({ requestHash: hashRequest(input), response: { subagentId: "child" } }) },
      subagentAttempt: { findUniqueOrThrow: async () => ({ id: "attempt", status, ...extra }) },
    };
    const service = new SubagentService(db, null as never, null as never, "/workspace", null as never, null as never) as any;
    service.attemptForCall = async () => ({ id: "attempt", runInBackground: false, parentRunId: "parent-run" });
    service.owned = async () => ({ id: "child" });
    return service.task({ botId: "parent", callId: "call" }, input);
  };
  const done: string = await run("completed", { result: "Found 3 flights." });
  expect(done).toStartWith("This is the output of the subagent:\n\nresponse:\n<response>\nFound 3 flights.\n</response>\n\nAgent ID: sand-subagent-child");
  expect(done).toContain("This dispatch names SendToUser");
  expect(await run("failed", { error: { code: "runtime_restart", message: "Runtime restarted during this turn" } })).toBe("Error: Runtime restarted during this turn");
});

const managed = (child: Record<string, unknown> | null) => {
  const running = { id: "busy", prompt: "Busy work" };
  const db: any = {
    subagent: {
      findFirst: async ({ where }: any) => (child && where.id === child.id ? child : null),
      findMany: async () => [running],
    },
  };
  return new SubagentService(db, null as never, null as never, "/workspace", null as never, null as never);
};

test("messaging, stopping or checking a subagent that is not running is an ordinary answer, not an error", async () => {
  const service = managed(null);
  expect(await service.message("parent", "call", { subagent_id: "sand-subagent-gone", message: "Hurry" })).toBe(NOT_RUNNING);
  expect(await service.stop("parent", "call", { subagent_id: "sand-subagent-gone" })).toBe(NOT_RUNNING);
  expect(await service.check("parent", { subagent_id: "sand-subagent-gone" })).toBe(NOT_RUNNING);
  const queued = managed({ id: "gone", status: "queued", currentRunId: "run" });
  expect(await queued.message("parent", "call", { subagent_id: "sand-subagent-gone", message: "Hurry" })).toBe(NOT_RUNNING);
});

test("resuming a subagent as another type is refused with the reference's reason", async () => {
  const db: any = { subagent: { findFirst: async () => ({ id: "child", status: "completed", subagentType: "computerUse" }) } };
  const service = new SubagentService(db, null as never, null as never, "/workspace", null as never, null as never) as any;
  await expect(service.resume({ botId: "parent" }, { description: "x", prompt: "Go on", resume: "sand-subagent-child", subagent_type: "executor" }))
    .rejects.toThrow('Cannot resume a "computerUse" subagent as "executor". A resumed subagent keeps its type: omit `subagent_type` to resume this child, or start a new "executor" subagent without `resume`.');
  await expect(service.resume({ botId: "parent" }, { description: "x", prompt: "Go on", resume: "sand-subagent-child", subagent_type: "computer_use" }))
    .rejects.not.toThrow("Cannot resume");
});
