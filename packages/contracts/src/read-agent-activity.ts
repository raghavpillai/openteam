import { referenceTool } from "./tool-contracts";

export const AGENT_ACTIVITY_LIMITS = {
  sinceHours: { fallback: 72, max: 168 },
  maxAgents: { fallback: 10, max: 20 },
  excerptChars: { fallback: 1500, max: 4000 },
} as const;

/** The captured ReadAgentActivity contract, adapted in tool-contracts. */
export const READ_AGENT_ACTIVITY_TOOL = referenceTool("ReadAgentActivity");

export interface AgentActivityBounds { sinceHours: number; maxAgents: number; excerptChars: number }

// Out-of-range values fall back to the default rather than failing the call.
const clamp = (value: unknown, limit: { fallback: number; max: number }) => {
  const floored = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return Number.isFinite(floored) && floored >= 1 ? Math.min(floored, limit.max) : limit.fallback;
};

export function parseReadAgentActivityInput(raw: unknown): AgentActivityBounds {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new Error("Expected an object");
  const input = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(READ_AGENT_ACTIVITY_TOOL.inputSchema.properties, key)) throw new Error(`Unknown field: ${key}`);
  return {
    sinceHours: clamp(input.since_hours, AGENT_ACTIVITY_LIMITS.sinceHours),
    maxAgents: clamp(input.max_agents, AGENT_ACTIVITY_LIMITS.maxAgents),
    excerptChars: clamp(input.excerpt_chars, AGENT_ACTIVITY_LIMITS.excerptChars),
  };
}
