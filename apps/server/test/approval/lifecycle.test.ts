import { describe, expect, test } from "bun:test";
import {
  APPROVAL_ASK_TTL_MS,
  approvalAskExpiryCutoff,
  expirePendingApprovalsAfterRestart,
  expireTimedOutApprovals,
} from "../../src/services/approval-lifecycle";

describe("approval lifecycle parity", () => {
  test("expires every runtime-owned pending card in place after restart", async () => {
    const calls: unknown[] = [];
    const database = {
      approval: {
        updateMany: async (input: unknown) => {
          calls.push(input);
          return { count: 2 };
        },
      },
    };
    const now = new Date("2026-08-27T10:10:00.000Z");

    await expirePendingApprovalsAfterRestart(database as never, now);

    expect(calls).toEqual([
      {
        where: { status: "pending" },
        data: { status: "expired", resolvedAt: now },
      },
    ]);
  });

  test("applies the ten-minute lifetime only to non-interactive/background asks", async () => {
    const calls: unknown[] = [];
    const database = {
      approval: {
        updateMany: async (input: unknown) => {
          calls.push(input);
          return { count: 1 };
        },
      },
    };
    const now = new Date("2026-08-27T10:10:00.000Z");

    await expireTimedOutApprovals(database as never, now);

    expect(APPROVAL_ASK_TTL_MS).toBe(600_000);
    expect(approvalAskExpiryCutoff(now).toISOString()).toBe("2026-08-27T10:00:00.000Z");
    expect(calls).toEqual([
      {
        where: {
          status: "pending",
          createdAt: { lt: new Date("2026-08-27T10:00:00.000Z") },
          run: {
            origin: {
              in: [
                "routine",
                "group",
                "bootstrap",
                "event",
                "background_revival",
                "handoff_resume",
                "broadcast",
              ],
            },
          },
        },
        data: { status: "expired", resolvedAt: now },
      },
    ]);
  });
});
