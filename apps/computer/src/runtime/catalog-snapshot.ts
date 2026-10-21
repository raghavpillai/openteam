import { renderCursorNamespaceStatement, renderDynamicToolCatalog, type CatalogNamespace } from "./prompt-context";

const ENTRY = "openteam-dynamic-tool-catalog";

interface PinnedCatalog {
  epoch: number;
  catalog: string | null;
  /** The cursor namespace the model was last told about, in user_info or an update. */
  cursor: string;
}

interface CatalogSessionLog {
  getEntries(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }>;
  appendCustomEntry(customType: string, data?: unknown): unknown;
}

/**
 * user_info stays the first message for a whole compaction epoch, so a catalog
 * change never rewrites it (that would drop the provider's prompt cache for the
 * conversation). As in the reference, a change to the first-party namespace is
 * announced on the next turn instead; connector namespaces are rediscovered
 * with GetDynamicTools until the next summary.
 */
export function pinDynamicToolCatalog(
  log: CatalogSessionLog,
  epoch: number,
  namespaces: readonly CatalogNamespace[]
): { catalog: string | null; update: string | null } {
  const cursor = renderCursorNamespaceStatement(namespaces);
  const pinned = log.getEntries().filter((entry) => entry.type === "custom" && entry.customType === ENTRY).at(-1)?.data as PinnedCatalog | undefined;
  if (!pinned || pinned.epoch !== epoch) {
    const catalog = renderDynamicToolCatalog(namespaces);
    log.appendCustomEntry(ENTRY, { epoch, catalog, cursor } satisfies PinnedCatalog);
    return { catalog, update: null };
  }
  if (pinned.cursor === cursor) return { catalog: pinned.catalog, update: null };
  log.appendCustomEntry(ENTRY, { ...pinned, cursor } satisfies PinnedCatalog);
  return {
    catalog: pinned.catalog,
    update: [
      "<system_reminder>",
      '<user_info_catalog_update sections="dynamic_tool_snapshot">',
      "The catalogs below have changed since the user_info message at the start of this conversation was written. They replace the same-named sections there; a later update of this kind replaces this one.",
      cursor,
      "</user_info_catalog_update>",
      "</system_reminder>",
    ].join("\n"),
  };
}
