import type { PermissionSettingsStore } from "./permission-settings";

export type AutoReviewMode = "off" | "shadow" | "enforce";
export type LocalPromptDecision = "deny" | "allow-once" | "always" | "never";
export type AutoReviewPromptDecision = "deny" | "allow-once" | "always";

export interface HostAction {
  surface:
    | "hostShell"
    | "hostRead"
    | "mcp"
    | "computer"
    | "automationWrite"
    | "cloudAgent"
    | "subagentLaunch";
  summary: string;
  target: string;
  command?: string;
  arguments?: Record<string, unknown>;
}

export interface AutoReviewResult {
  decision: "allow" | "block" | "reject";
  reason: string;
  proposedRule?: string;
}

export interface HostPermissionDependencies {
  settings: PermissionSettingsStore;
  mode: AutoReviewMode;
  promptLocal(action: HostAction): Promise<LocalPromptDecision>;
  review(
    action: HostAction,
    rules: { allowInstructions: string[]; blockInstructions: string[] }
  ): Promise<AutoReviewResult>;
  promptAutoReview(
    action: HostAction,
    result: Extract<AutoReviewResult, { decision: "block" }> | AutoReviewResult
  ): Promise<AutoReviewPromptDecision>;
}

export interface HostPermissionResult {
  allowed: boolean;
  reason?: string;
  gate?: "local" | "auto-review";
}

const exactAllowRule = (action: HostAction): string =>
  action.surface === "hostShell"
    ? `Allow this exact host command: ${action.command ?? action.target}`
    : action.surface === "hostRead"
      ? `Allow reading this exact host file: ${action.target}`
      : `Allow this exact ${action.surface} action: ${action.summary}`;

const authorizeReviewedAction = async (
  action: HostAction,
  dependencies: HostPermissionDependencies
): Promise<HostPermissionResult> => {
  const settings = await dependencies.settings.read();
  if (!settings.autoReview.isEnabled || dependencies.mode === "off") return { allowed: true };
  if (dependencies.mode === "shadow") {
    void dependencies.review(action, settings.autoReview).catch(() => undefined);
    return { allowed: true };
  }

  let review: AutoReviewResult;
  try {
    review = await dependencies.review(action, settings.autoReview);
  } catch (error) {
    return {
      allowed: false,
      gate: "auto-review",
      reason: `Auto Review failed closed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (review.decision === "allow") return { allowed: true };
  if (review.decision === "reject") {
    return {
      allowed: false,
      gate: "auto-review",
      reason: review.reason || "Auto Review rejected the action",
    };
  }

  const decision = await dependencies.promptAutoReview(action, review);
  if (decision === "deny") {
    return { allowed: false, gate: "auto-review", reason: "The user denied the reviewed action" };
  }
  if (decision === "always") {
    await dependencies.settings.addRule(
      "allow",
      review.proposedRule?.trim().slice(0, 500) || exactAllowRule(action)
    );
  }
  return { allowed: true };
};

export const authorizeAutoReviewAction = (
  action: HostAction,
  dependencies: HostPermissionDependencies
): Promise<HostPermissionResult> => authorizeReviewedAction(action, dependencies);

export const authorizeHostAction = async (
  action: HostAction,
  dependencies: HostPermissionDependencies
): Promise<HostPermissionResult> => {
  let settings = await dependencies.settings.read();

  if (settings.localToolPermission === "never") {
    return { allowed: false, gate: "local", reason: "Local computer execution is disabled" };
  }
  if (settings.localToolPermission === "ask") {
    const decision = await dependencies.promptLocal(action);
    if (decision === "deny") {
      return { allowed: false, gate: "local", reason: "The user denied this local action" };
    }
    if (decision === "never") {
      await dependencies.settings.update({ localToolPermission: "never" });
      return { allowed: false, gate: "local", reason: "Local computer execution is disabled" };
    }
    if (decision === "always") {
      settings = await dependencies.settings.update({ localToolPermission: "always" });
    }
  }

  return authorizeReviewedAction(action, dependencies);
};
