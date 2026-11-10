/** Directory pages are bounded before MCP serialization; provider records remain intact. */
export function directoryPage(
  kind: "contacts" | "groups",
  value: unknown,
  options: { offset?: number; limit?: number } = {}
) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 25;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("Use a nonnegative offset and a limit from 1 to 100.");
  if (
    !Array.isArray(value) ||
    value.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  )
    throw new Error("Signal returned an invalid directory.");
  const key = (row: Record<string, unknown>) => String(row.uuid ?? row.id ?? row.number ?? "");
  const records = [...value].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const selected: unknown[] = [];
  const page = () => ({
    [kind]: selected,
    offset,
    nextOffset: offset + selected.length < records.length ? offset + selected.length : null,
    total: records.length,
  });
  for (const row of records.slice(offset, offset + limit)) {
    selected.push(row);
    if (JSON.stringify(page()).length > 70_000) {
      selected.pop();
      if (!selected.length)
        throw new Error(
          "A single directory entry exceeds the response limit. Use a targeted lookup for other entries."
        );
      break;
    }
  }
  return page();
}
