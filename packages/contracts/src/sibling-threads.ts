export const READ_SIBLING_THREAD_TOOL = {
  name: "read_sibling_thread",
  description: "Read a bounded slice of another of this agent's active conversations. Use when you need cross-conversation context; never substitute this for the current conversation's transcript.",
  inputSchema: {
    type: "object", properties: {
      session_id: { type: "string", minLength: 1, description: "The sibling session id to read (from the other active conversations list)." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum transcript rows to return (default 20, hard cap 50)." },
    }, required: ["session_id"], additionalProperties: false,
  },
};

export function parseSiblingThreadInput(raw: unknown): { session_id: string; limit: number } {
  const value = raw as { session_id?: unknown; limit?: unknown } | null;
  if (!value || typeof value.session_id !== "string" || !value.session_id.trim()) throw new Error("session_id is required");
  const limit = value.limit ?? 20;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer between 1 and 50");
  return { session_id: value.session_id.trim(), limit };
}
