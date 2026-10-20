import { referenceTool } from "./tool-contracts";

/** The captured ReadTranscript contract, adapted in tool-contracts. */
export const READ_TRANSCRIPT_TOOL = referenceTool("ReadTranscript");
/** What a worker sees: its own run, and the user's other agents, but never the parent's main chat. */
export const READ_TRANSCRIPT_SUBAGENT_DESCRIPTION = "Read saved observable messages and tool activity. With no id it reads your own run, including what was compacted out of your context. agent_id reads another active agent's visible messages, and session_id another conversation of your parent readable from the one you were started in (none from its main chat); anywhere else only your own run is readable. You dispatch no subagents, so subagent_id is not available. Returns newest rows in chronological order; pass next_before to page backward. Private reasoning, system instructions, form values, and privileged tool payloads are excluded.";
export const READ_TRANSCRIPT_SUBAGENT_REFUSAL = "You dispatch no subagents, so there is no subagent transcript to read. Omit subagent_id to read your own transcript.";

export function parseReadTranscriptInput(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected an object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(READ_TRANSCRIPT_TOOL.inputSchema.properties, key)) throw new Error(`Unknown field: ${key}`);
  const targets: Record<string, string> = {};
  for (const key of ["session_id", "agent_id", "subagent_id"]) if (input[key] !== undefined) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`${key} must be a nonempty string`);
    targets[key] = input[key].trim();
  }
  if (Object.keys(targets).length > 1) throw new Error("Specify at most one target ID");
  const limit = input.limit ?? 30, before = input.before;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error("limit must be an integer between 1 and 200");
  if (before !== undefined && (!Number.isSafeInteger(before) || Number(before) < 0)) throw new Error("before must be a nonnegative integer");
  return { ...targets, limit: Number(limit), before: before === undefined ? undefined : Number(before) } as {session_id?: string; agent_id?: string; subagent_id?: string; limit: number; before?: number};
}
