interface SessionLog {
  getEntries(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }>;
  appendCustomEntry(customType: string, data?: unknown): unknown;
}

interface Snapshot {
  epoch: number;
  base: string;
  catalog: string | null;
  announced: string;
}

const ENTRY = "openteam-user-info-snapshot";

/** Pin the complete opening message, including environment lines, for an epoch.
 * Keep the reference's opening layout and append later changes to the history,
 * using the same catalog-update envelope as first-party tool changes. */
export function pinUserInfo(
  log: SessionLog,
  epoch: number,
  base: string,
  catalog: string | null
): { content: string; update: string | null; acknowledge(): void } {
  const previous = log
    .getEntries()
    .findLast((entry) => entry.type === "custom" && entry.customType === ENTRY)?.data as
    | Snapshot
    | undefined;
  const snapshot = previous?.epoch === epoch ? previous : { epoch, base, catalog, announced: base };
  if (snapshot !== previous) log.appendCustomEntry(ENTRY, snapshot);
  const content = [snapshot.base, snapshot.catalog].filter(Boolean).join("\n\n");
  if (snapshot.announced === base) return { content, update: null, acknowledge() {} };
  return {
    content,
    update: [
      "<system_reminder>",
      '<user_info_catalog_update sections="user_info memory_context available_subagent_types teammates agent_skills">',
      "The user information and catalogs below replace those same-named sections at the start of this conversation. A section omitted below is now empty. The dynamic tool catalog is unchanged; its separate updates still apply.",
      base,
      "</user_info_catalog_update>",
      "</system_reminder>",
    ].join("\n"),
    // Record delivery only after the update was appended, so a failed append is
    // retried on the next turn. The opening snapshot itself never changes.
    acknowledge() {
      log.appendCustomEntry(ENTRY, { ...snapshot, announced: base } satisfies Snapshot);
    },
  };
}
