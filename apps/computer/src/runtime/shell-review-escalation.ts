import { createHash } from "node:crypto";
import type { ShellToolInput } from "@openteam/contracts";
import { HostApprovalRequiredError, type HostApprovalTokens } from "../native-tool-executor";

/** A recorded block is evidence for an approval card, never permission to run.
 * Keep command-bound blocks in this turn; consume each on explicit retry. */
export class ShellReviewEscalation {
  private readonly blocked = new WeakMap<object, Map<string, {
    identity: string;
    reason: string;
    error: HostApprovalRequiredError;
  }>>();

  invalidate(turn: object): void {
    this.blocked.delete(turn);
  }

  wrap<T>(
    turn: object,
    target: readonly unknown[],
    input: ShellToolInput,
    execute: (approvals: HostApprovalTokens) => Promise<T>
  ): (approvals: HostApprovalTokens) => Promise<T> {
    const identity = createHash("sha256").update(JSON.stringify([target, input.command])).digest("hex");
    const receipts = this.blocked.get(turn) ?? new Map();
    this.blocked.set(turn, receipts);
    const previous = receipts.get(identity);
    receipts.delete(identity);
    let escalation: HostApprovalRequiredError | undefined;
    if (input.request_smart_mode_approval) {
      if (!previous || previous.identity !== identity || input.smart_mode_block_reason !== previous.reason)
        throw new Error("No matching prior Shell block. Approval requests must immediately retry the same command and target with the exact smart_mode_block_reason returned by Auto-review. This action was not executed.");
      escalation = previous.error;
    }
    return async (approvals) => {
      // The existing approval loop alone supplies this token after a user decision.
      if (escalation && !approvals.autoReviewApproval) throw escalation;
      try {
        return await execute(approvals);
      } catch (error) {
        if (!escalation && error instanceof HostApprovalRequiredError && error.approval.gate === "auto-review") {
          const reason = typeof error.approval.details.reason === "string"
            ? error.approval.details.reason : "Auto-review requires approval for this command";
          receipts.set(identity, { identity, reason,
            error: new HostApprovalRequiredError(structuredClone(error.approval)) });
          throw new Error(`Auto-review blocked this command. It was not executed.\nBlock reason: ${reason}\nUse an allowed alternative. If user approval is appropriate, explicitly retry this exact command and target with request_smart_mode_approval: true and smart_mode_block_reason set to the exact block reason above.`);
        }
        throw error;
      }
    };
  }
}
