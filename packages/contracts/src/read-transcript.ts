export const READ_TRANSCRIPT_TOOL = {
  name: "ReadTranscript",
  description: "Read saved observable conversation messages and tool activity, including history preceding compaction. Omit target IDs for the current conversation, use session_id for another conversation of this agent, agent_id for an active agent in this deployment, or subagent_id for your dispatched worker (running or finished). Returns newest rows in chronological order; pass next_before to page backward. Private reasoning, system instructions, form values, and privileged tool payloads are excluded. Large text retains its beginning and end with an explicit truncation notice. Use a smaller limit to allow more text per row within the response budget; before pages records, not text within one record.",
  inputSchema: { type: "object", properties: {
    session_id: { type: "string" }, agent_id: { type: "string" }, subagent_id: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum rows, default 30." },
    before: { type: "integer", minimum: 0, description: "Exclusive position cursor returned by an earlier page." },
  }, additionalProperties: false },
};
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
