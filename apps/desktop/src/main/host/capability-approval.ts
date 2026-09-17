import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { HostApprovalRequest, HostApprovalTokens } from "@openteam/contracts/service-protocol";
import type { NativeConsent } from "./capability-settings";

export class CapabilityApprovalRequired extends Error {
  constructor(readonly approval: HostApprovalRequest) {
    super("User approval is required");
  }
}

/** Keep private native consent on the same durable chat-card path as other reviews. */
export class CapabilityApprovals {
  private readonly context = new AsyncLocalStorage<{
    request: Record<string, any>;
    epoch: number;
  }>();
  private readonly pending = new Map<string, { fingerprint: string; expires: number }>();
  constructor(
    private readonly fallback: NativeConsent,
    private readonly now = Date.now
  ) {}
  run<T>(request: Record<string, any>, epoch: number, work: () => T): T {
    return this.context.run({ request, epoch }, work);
  }
  readonly consent: NativeConsent = async (input) => {
    const context = this.context.getStore();
    if (!context || context.request.chatApproval !== true) return this.fallback(input);
    const { request, epoch } = context;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          botId: request.botId,
          callId: request.callId,
          tool: request.tool,
          args: request.arguments,
          epoch,
          input,
        })
      )
      .digest("hex");
    for (const [token, item] of this.pending)
      if (item.expires < this.now()) this.pending.delete(token);
    const approvals: HostApprovalTokens["capabilityApprovals"] = request.capabilityApprovals;
    for (const supplied of Array.isArray(approvals) ? approvals : []) {
      const previous = this.pending.get(supplied.token);
      if (
        previous?.fingerprint === fingerprint &&
        ["allow-once", "always"].includes(supplied.decision)
      ) {
        if (supplied.selectedItems !== undefined) {
          const offered = new Set(input.presentation?.kind === "cookie-import" ? input.presentation.items.map((item) => JSON.stringify([item.profileId, item.origin])) : []);
          if (!input.selectItems || supplied.selectedItems.length === 0 || supplied.selectedItems.some((key) => !offered.has(key)))
            throw new Error("The selected sites do not match this approval");
          input.selectItems(supplied.selectedItems);
        }
        return supplied.decision === "always" && input.allowAlways ? "always" : "once";
      }
    }
    if (this.pending.size >= 1000) throw new Error("Too many pending native approvals");
    const token = crypto.randomUUID();
    this.pending.set(token, { fingerprint, expires: this.now() + 15 * 60_000 });
    throw new CapabilityApprovalRequired({
      gate: "capability",
      requestMethod: "openteam/capability",
      token,
      details: {
        type: "nativeCapability",
        action: input.title,
        toolName: request.tool,
        summary: input.title,
        effect: input.detail,
        supportsAlwaysAllow: input.allowAlways === true,
        supportsNever: false,
        ...(input.presentation ? { presentation: input.presentation } : {}),
      },
    });
  };
}
