import type { ToolDecision } from "./types";
export interface ToolPolicy {
  toolName: string;
  botId: string | null;
  enabled?: boolean;
  decision: ToolDecision;
}
export function effectiveToolPolicy(
  policies: readonly ToolPolicy[],
  name: string,
  botId: string,
  fallback: ToolDecision
): { enabled: boolean; decision: ToolDecision } {
  const matches = policies.filter(
    (policy) => policy.toolName === name && (policy.botId === null || policy.botId === botId)
  );
  const workspace = matches.filter((policy) => policy.botId === null);
  const bot = matches.find((policy) => policy.botId === botId);
  return {
    enabled: !matches.some((policy) => policy.enabled === false),
    decision: workspace.some((policy) => policy.decision === "deny")
      ? "deny"
      : (bot?.decision ?? workspace[0]?.decision ?? fallback),
  };
}
