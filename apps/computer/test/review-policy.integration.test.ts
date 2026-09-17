import { test, expect } from "bun:test";
import { createPrismaClient } from "../../../packages/db/src";
import { ReviewPolicyService } from "../../server/src/services/review-policy-service";
import { NativeToolExecutor, HostApprovalRequiredError } from "../src/native-tool-executor";

test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL)(
  "box reviews use persisted rules and scoped provenance without a desktop connection",
  async () => {
    const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL!);
    const seen: any[] = [];
    const policy = new ReviewPolicyService(db, {
      review: async (input: any) => {
        seen.push(input);
        return { decision: "block", reason: "Review fixture action" };
      },
    } as any);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/v0/internal/permissions/review-action");
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-control");
        return policy.action(await request.json());
      },
    });
    try {
      await policy.save({
        isEnabled: true,
        allowInstructions: ["Allow fixture reads"],
        blockInstructions: ["Ask before publishing"],
      });
      const native = new NativeToolExecutor({
        agentDir: "/tmp/review-fixture",
        serverUrl: server.url.origin,
        hostBridgeUrl: "http://127.0.0.1:1",
        controlToken: "synthetic-control",
      });
      const a = { runId: crypto.randomUUID(), botId: crypto.randomUUID() },
        b = { runId: crypto.randomUUID(), botId: crypto.randomUUID() };
      const action = {
        surface: "computer" as const,
        summary: "Click submit",
        target: "box",
        arguments: { tool: "browser_click", ref: "button-1" },
      };
      const results = await Promise.all(
        [a, b].map((context) =>
          native.withReviewContext(context, () =>
            native.autoReviewAction(action).catch((error) => error)
          )
        )
      );
      expect(results.every((result) => result instanceof HostApprovalRequiredError)).toBe(true);
      expect(seen.map((row) => row.reviewContext)).toEqual(expect.arrayContaining([a, b]));
      expect(seen[0].blockInstructions).toEqual(["Ask before publishing"]);
      await native.withReviewContext(a, () =>
        native.autoReviewAction(action, undefined, { autoReviewApproval: "always" })
      );
      expect((await policy.view()).allowInstructions.at(-1)).toContain('"ref":"button-1"');
      await policy.save({ isEnabled: false, allowInstructions: [], blockInstructions: [] });
      await native.autoReviewAction(action);
      expect(seen).toHaveLength(2);
    } finally {
      server.stop(true);
      await db.autoReviewPolicy.deleteMany({ where: { id: "global" } });
      await db.$disconnect();
    }
  }
);
