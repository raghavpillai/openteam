import { referenceTool } from "./tool-contracts";

/** The captured ReadTranscript contract, adapted in tool-contracts. */
export const READ_TRANSCRIPT_TOOL = referenceTool("ReadTranscript");

/** `in` names one transcript: "this" (the default) or a session, owned agent, or dispatched subagent id. */
export function parseReadTranscriptInput(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected an object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(READ_TRANSCRIPT_TOOL.inputSchema.properties, key)) throw new Error(`Unknown field: ${key}`);
  if (input.in !== undefined && typeof input.in !== "string") throw new Error("in must be a string");
  const scope = (input.in as string | undefined)?.trim() || "this";
  if (scope === "all") throw new Error("ReadTranscript reads one transcript at a time: pass in=this or one id.");
  const limit = input.limit ?? 30, before = input.before;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error("limit must be an integer between 1 and 200");
  if (before !== undefined && (!Number.isSafeInteger(before) || Number(before) < 0)) throw new Error("before must be a nonnegative integer");
  return { in: scope, limit: Number(limit), before: before === undefined ? undefined : Number(before) };
}
