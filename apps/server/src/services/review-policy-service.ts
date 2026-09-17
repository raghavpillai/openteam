import { ApiError } from "@openteam/contracts";
import { parseHostAutoReviewRequest } from "@openteam/contracts/service-protocol";
import type { PrismaClient } from "@openteam/db";
import { parseAutoReviewInput, type AutoReviewService } from "./auto-review-service";

export class ReviewPolicyService {
  constructor(
    private readonly db: PrismaClient,
    private readonly classifier: AutoReviewService
  ) {}
  async view() {
    const row = await this.db.autoReviewPolicy.findUnique({ where: { id: "global" } });
    return {
      configured: !!row,
      isEnabled: row?.enabled ?? true,
      allowInstructions: row?.allowInstructions ?? [],
      blockInstructions: row?.blockInstructions ?? [],
    };
  }
  async save(input: any) {
    if (
      typeof input?.isEnabled !== "boolean" ||
      [input.allowInstructions, input.blockInstructions].some(
        (rows) =>
          !Array.isArray(rows) ||
          rows.length > 20 ||
          rows.some((row: unknown) => typeof row !== "string" || !row.trim() || row.length > 1000)
      )
    )
      throw new ApiError(400, "review_policy_invalid", "Invalid Auto Review settings");
    await this.db.autoReviewPolicy.upsert({
      where: { id: "global" },
      create: {
        id: "global",
        enabled: input.isEnabled,
        allowInstructions: input.allowInstructions,
        blockInstructions: input.blockInstructions,
      },
      update: {
        enabled: input.isEnabled,
        allowInstructions: input.allowInstructions,
        blockInstructions: input.blockInstructions,
      },
    });
    return this.view();
  }
  async action(raw: unknown): Promise<Response> {
    const action = parseHostAutoReviewRequest(raw);
    const exactRule = `Allow this exact ${action.surface} action on ${action.target}: ${JSON.stringify(action.arguments ?? { summary: action.summary })}`;
    const rules = await this.view();
    if (!rules.isEnabled) return Response.json({ allowed: true });
    if (action.autoReviewApproval) {
      if (action.autoReviewApproval === "always") {
        // Store only this reviewed action, never a broader model-proposed permission.
        if (exactRule.length > 1000)
          throw new ApiError(400, "review_rule_too_long", "Use Approve once for this action");
        const instruction = exactRule;
        await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(742310, 8)::text`;
          const current = await tx.autoReviewPolicy.findUnique({ where: { id: "global" } });
          const allowInstructions = [
            ...new Set([...(current?.allowInstructions ?? []), instruction]),
          ].slice(-20);
          await tx.autoReviewPolicy.upsert({
            where: { id: "global" },
            create: { id: "global", allowInstructions },
            update: { allowInstructions },
          });
        });
      }
      return Response.json({ allowed: true });
    }
    const result = await this.classifier.review(parseAutoReviewInput({ ...action, ...rules }));
    if (result.decision === "allow") return Response.json({ allowed: true });
    if (result.decision === "reject")
      return Response.json(
        { error: `Auto Review failed closed: ${result.reason}` },
        { status: 403 }
      );
    return Response.json(
      {
        error: "approval_required",
        approval: {
          gate: "auto-review",
          requestMethod: "openteam/autoReview",
          details: {
            type: "autoReview",
            gate: "auto-review",
            action: action.surface === "boxShell" ? "runCommand" : "runTask",
            toolName:
              action.surface === "boxShell"
                ? "Shell"
                : action.surface === "subagentLaunch"
                  ? "Task"
                  : String(action.arguments?.tool ?? "Computer"),
            effect: "Auto Review requires your approval before this action can run.",
            summary: action.summary,
            reason: result.reason,
            arguments: action.arguments,
            supportsAlwaysAllow: exactRule.length <= 1000,
            ...(exactRule.length <= 1000 ? { proposedRule: exactRule } : {}),
          },
        },
      },
      { status: 409 }
    );
  }
}
