import { objectValue } from "./manifest";

/** A connector call's own budget; the agent's per-call guard (14 minutes) gives up first, as in the reference. */
export const MCP_TOOL_CALL_TIMEOUT_MS = 60 * 60_000;

/**
 * One tools/list page, repaired as the reference does when the SDK's strict
 * parse rejects it: the page is read again unchecked, a missing
 * inputSchema.type is filled, a rejected outputSchema is dropped, and a tool
 * that is still invalid is left out instead of failing the whole server.
 */
export async function repairedToolsPage<T>(
  list: () => Promise<{ tools: T[]; nextCursor?: string }>,
  listUnchecked: () => Promise<unknown>,
  parseTool: (tool: unknown) => T | undefined,
  onLeftOut: (name: string) => void = () => {}
): Promise<{ tools: T[]; nextCursor?: string }> {
  try {
    return await list();
  } catch (error) {
    // The SDK's strict schema rejects the page (zod's error class, named ZodError or $ZodError).
    if (!/^\$?ZodError$/.test(String((error as { name?: unknown } | null)?.name))) throw error;
  }
  const page = objectValue(await listUnchecked());
  const tools = (Array.isArray(page.tools) ? page.tools : []).flatMap((candidate): T[] => {
    const tool = objectValue(candidate);
    const input = objectValue(tool.inputSchema);
    const filled = tool.inputSchema !== undefined && input.type === undefined ? { ...tool, inputSchema: { ...input, type: "object" } } : tool;
    const { outputSchema: _outputSchema, ...withoutOutput } = filled;
    const parsed = parseTool(filled) ?? ("outputSchema" in filled ? parseTool(withoutOutput) : undefined);
    if (parsed === undefined) onLeftOut(tool.name === undefined ? "(unnamed)" : String(tool.name));
    return parsed === undefined ? [] : [parsed];
  });
  return { tools, ...(typeof page.nextCursor === "string" ? { nextCursor: page.nextCursor } : {}) };
}

/** Follow all MCP pages, rejecting broken cursors and bounding a server's catalog. */
export async function discoverAllTools<T extends { name: string }>(
  list: (cursor?: string) => Promise<{ tools: T[]; nextCursor?: string }>
): Promise<T[]> {
  const tools = new Map<string, T>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await list(cursor);
    for (const tool of page.tools) tools.set(tool.name, tool);
    if (tools.size > 10_000) throw new Error("MCP server exceeds 10,000 tools");
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor) || cursors.size >= 100)
        throw new Error("MCP server returned an invalid pagination cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  return [...tools.values()];
}
