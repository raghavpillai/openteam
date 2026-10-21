/** A connector call's own budget; the agent's per-call guard (14 minutes) gives up first, as in the reference. */
export const MCP_TOOL_CALL_TIMEOUT_MS = 60 * 60_000;

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
