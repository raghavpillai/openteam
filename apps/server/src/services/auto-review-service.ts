import { ApiError, formatPiModelRef, type ServerInferenceSettings } from "@openbot/contracts";
import {
  COMPUTER_API_PATHS,
  type ComputerInferenceRequest,
} from "@openbot/contracts/service-protocol";
import type { ComputerFetch } from "./service-utils";

const SURFACES = new Set([
  "hostShell",
  "hostRead",
  "mcp",
  "computer",
  "automationWrite",
  "cloudAgent",
  "subagentLaunch",
]);

export interface AutoReviewInput {
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
  allowInstructions: string[];
  blockInstructions: string[];
}

export interface AutoReviewOutput {
  decision: "allow" | "block" | "reject";
  reason: string;
  proposedRule?: string;
}

const boundedRules = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "invalid_auto_review", "Rules must contain at most 20 entries");
  }
  return value.map((rule) => {
    if (typeof rule !== "string" || !rule.trim() || rule.length > 1_000) {
      throw new ApiError(400, "invalid_auto_review", "Each rule must be 1 to 1000 characters");
    }
    return rule.trim();
  });
};

export const parseAutoReviewInput = (value: unknown): AutoReviewInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_auto_review", "Auto Review input must be an object");
  }
  const input = value as Record<string, unknown>;
  if (!SURFACES.has(String(input.surface))) {
    throw new ApiError(400, "invalid_auto_review", "Unknown Auto Review surface");
  }
  if (
    typeof input.summary !== "string" ||
    !input.summary.trim() ||
    input.summary.length > 500 ||
    typeof input.target !== "string" ||
    !input.target.trim() ||
    input.target.length > 4_000 ||
    (input.command !== undefined &&
      (typeof input.command !== "string" || input.command.length > 4_000)) ||
    (input.arguments !== undefined &&
      (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)))
  ) {
    throw new ApiError(400, "invalid_auto_review", "Auto Review action is malformed or too large");
  }
  return {
    surface: input.surface as AutoReviewInput["surface"],
    summary: input.summary.trim(),
    target: input.target.trim(),
    command: typeof input.command === "string" ? input.command : undefined,
    arguments: input.arguments as Record<string, unknown> | undefined,
    allowInstructions: boundedRules(input.allowInstructions),
    blockInstructions: boundedRules(input.blockInstructions),
  };
};

const sanitizeText = (value: unknown, maximum: number): string =>
  typeof value === "string" ? value.trim().slice(0, maximum) : "";

export const parseAutoReviewResponse = (text: string): AutoReviewOutput | null => {
  try {
    const value = JSON.parse(text.trim()) as Record<string, unknown>;
    const rawDecision = String(value.decision ?? "").toLowerCase();
    if (rawDecision !== "allow" && rawDecision !== "block") return null;
    const reason = sanitizeText(value.reason, 500);
    if (!reason) return null;
    const proposedRule = sanitizeText(value.proposedRule, 500);
    return {
      decision: rawDecision,
      reason,
      ...(proposedRule ? { proposedRule } : {}),
    };
  } catch {
    return null;
  }
};

const instructions = `You are OpenBot Auto Review, a fail-closed permission classifier.
Evaluate exactly one proposed side effect. User block rules ("ask first") always override user allow
rules when both could match. Built-in safety checks still apply even when an allow rule matches.
ALLOW only when this exact action is safe to run without another user decision. BLOCK when the user
must decide. Treat credential entry, passkeys, 2FA, CAPTCHAs, purchases, financial transactions,
destructive operations, permission changes, broad data disclosure, and ambiguous commands as BLOCK.
Return ONLY one JSON object with: decision ("allow" or "block"), reason (max 500 chars), and an
optional proposedRule (max 500 chars) that narrowly describes this action for a future allow rule.`;

export class AutoReviewService {
  constructor(
    private readonly computerFetch: ComputerFetch,
    private readonly inferenceSettings?: () => Promise<ServerInferenceSettings>
  ) {}

  async review(input: AutoReviewInput): Promise<AutoReviewOutput> {
    const prompt = JSON.stringify({
      precedence: "blockInstructions override allowInstructions",
      blockInstructions: input.blockInstructions,
      allowInstructions: input.allowInstructions,
      action: {
        surface: input.surface,
        summary: input.summary,
        target: input.target,
        command: input.command,
        arguments: input.arguments,
      },
    });
    try {
      const inference = await this.inferenceSettings?.();
      const request = {
        kind: "verification",
        instructions,
        prompt,
        timeoutMs: 15_000,
        ...(inference
          ? { model: formatPiModelRef(inference), reasoning: inference.reasoning }
          : {}),
      } satisfies ComputerInferenceRequest;
      const response = await this.computerFetch(COMPUTER_API_PATHS.inference, {
        method: "POST",
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return { decision: "reject", reason: `Auto Review failed (${response.status})` };
      }
      const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
      const parsed = typeof body?.text === "string" ? parseAutoReviewResponse(body.text) : null;
      return parsed ?? { decision: "reject", reason: "Auto Review returned an invalid decision" };
    } catch (error) {
      return {
        decision: "reject",
        reason:
          `Auto Review failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            500
          ),
      };
    }
  }
}
