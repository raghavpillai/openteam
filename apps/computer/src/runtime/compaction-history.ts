import {
  buildContextEntries,
  buildSessionContext,
  sessionEntryToContextMessages,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  BotArchiveBlob,
  BotCompactionArchiveStore,
  BotCompactionCoordinator,
  BotMessage,
} from "../bot-compaction";

type Boundary = NonNullable<BotArchiveBlob["piBoundary"]>;
const detailsId = (entry: SessionEntry): string | undefined => {
  if (entry.type !== "compaction" || !entry.details || typeof entry.details !== "object") return;
  const details = entry.details as Record<string, unknown>;
  return details.openteamBotCompaction === true && typeof details.id === "string"
    ? details.id
    : undefined;
};
const olderContext = (id: string): never => {
  throw new Error(
    `Pi context is older than its compaction archive for ${id}: cannot prove archive branch boundary`
  );
};

/** Recover at the persisted checkpoint, never at the current (possibly later) leaf. */
export async function recoverStagedPiCompaction(
  coordinator: BotCompactionCoordinator,
  manager: SessionManager,
  contextSessionId: string
): Promise<void> {
  const staged = await coordinator.stagedId(contextSessionId);
  if (!staged) return;
  const branch = manager.getBranch();
  const checkpoints = branch.filter((entry) => detailsId(entry) === staged);
  if (checkpoints.length > 1) return olderContext(contextSessionId);
  const checkpoint = checkpoints[0];
  await coordinator.recoverStaged(
    contextSessionId,
    checkpoint ? buildSessionContext(branch, checkpoint.id).messages.length : 0,
    checkpoint ? [staged] : [],
    checkpoint ? { leafId: checkpoint.id, compactionEntryId: checkpoint.id } : undefined
  );
}

/**
 * Count-based legacy archives can only be interpreted in their original Pi view.
 * A matching compaction ID proves that view. Projected legacy archives instead
 * need their persisted first-request usage receipt on this branch, with no
 * intervening compaction since archive creation. Without that proof, fail closed.
 */
function legacyBoundary(branch: SessionEntry[], archive: BotArchiveBlob, id: string): Boundary {
  const checkpoints = branch.filter((entry) => detailsId(entry) === archive.id);
  if (checkpoints.length > 1) return olderContext(id);
  const checkpoint = checkpoints[0];
  if (checkpoint) return { leafId: checkpoint.id, compactionEntryId: checkpoint.id };
  const receiptIndex = branch.findIndex(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "openteam-compaction-usage" &&
      (entry.data as { compactionId?: string } | undefined)?.compactionId === archive.id
  );
  if (receiptIndex < 0) return olderContext(id);
  const beforeReceipt = branch.slice(0, receiptIndex + 1);
  const basis = beforeReceipt.findLast((entry) => entry.type === "compaction");
  // Timestamps are used only to reject ambiguous legacy provenance, never to
  // choose a message boundary. New archives carry exact entry IDs.
  if (basis && Date.parse(basis.timestamp) >= Date.parse(archive.completedAt))
    return olderContext(id);
  let count = 0;
  for (const entry of buildContextEntries(beforeReceipt)) {
    count += sessionEntryToContextMessages(entry).length;
    if (count === archive.piBaseMessageCount) {
      // Pi places the summary before its kept messages, although its durable
      // checkpoint follows them. The boundary must include that checkpoint.
      const leaf =
        basis && beforeReceipt.indexOf(basis) > beforeReceipt.indexOf(entry) ? basis : entry;
      return { leafId: leaf.id, compactionEntryId: basis?.id ?? null };
    }
  }
  return olderContext(id);
}

function messagesAtBoundary(branch: SessionEntry[], boundary: Boundary, id: string): BotMessage[] {
  const end = branch.findIndex((entry) => entry.id === boundary.leafId);
  const start =
    boundary.compactionEntryId === null
      ? -1
      : branch.findIndex(
          (entry) => entry.id === boundary.compactionEntryId && entry.type === "compaction"
        );
  if (end < 0 || (boundary.compactionEntryId !== null && start < 0) || start > end)
    return olderContext(id);
  const base = start < 0 ? [] : buildSessionContext(branch, boundary.compactionEntryId).messages;
  return [
    ...base,
    ...branch
      .slice(start + 1, end + 1)
      .filter((entry) => entry.type !== "compaction")
      .flatMap(sessionEntryToContextMessages),
  ] as BotMessage[];
}

export interface CompactionHistory {
  read(): BotMessage[];
  boundary(): Boundary | undefined;
  acceptCompaction(entryId: string): void;
  hasUnmeasuredRecovery(): boolean;
  acceptUsage(): void;
}

/**
 * One startup scan establishes branch provenance. Healthy reads keep Pi's usual
 * builder; recovered reads incrementally project newly persisted entries. Native
 * summaries never replace the archive's coordinate system or execute any tools.
 */
export async function prepareCompactionHistory(
  coordinator: BotCompactionCoordinator,
  store: BotCompactionArchiveStore,
  manager: SessionManager,
  contextSessionId: string
): Promise<CompactionHistory> {
  await recoverStagedPiCompaction(coordinator, manager, contextSessionId);
  const archive = await store.latest(contextSessionId);
  const branch = manager.getBranch();
  let basis = branch.findLast((entry) => entry.type === "compaction")?.id ?? null;
  let leaf = manager.getLeafId();
  let recovered: BotMessage[] | undefined;
  let unmeasuredRecovery = false;
  if (archive) {
    let boundary = archive.piBoundary;
    // Length alone cannot prove ancestry, even on a seemingly healthy branch.
    if (!boundary) boundary = legacyBoundary(branch, archive, contextSessionId);
    if (boundary) {
      const base = messagesAtBoundary(branch, boundary, contextSessionId);
      if (base.length !== archive.piBaseMessageCount) return olderContext(contextSessionId);
      if (basis !== boundary.compactionEntryId) {
        basis = boundary.compactionEntryId;
        const end = branch.findIndex((entry) => entry.id === boundary.leafId);
        recovered = [
          ...base,
          ...branch
            .slice(end + 1)
            .filter((entry) => entry.type !== "compaction")
            .flatMap(sessionEntryToContextMessages),
        ] as BotMessage[];
        unmeasuredRecovery = true;
      }
    }
  }
  // Cache the last durable view only when needed. On an unexpected native
  // compaction, reconstruct from the accepted basis once, even if counts grew.
  return {
    read() {
      const currentLeaf = manager.getLeafId();
      const appended: SessionEntry[] = [];
      let cursor = currentLeaf;
      while (cursor !== leaf) {
        const entry = cursor ? manager.getEntry(cursor) : undefined;
        if (!entry) return olderContext(contextSessionId);
        appended.push(entry);
        cursor = entry.parentId;
      }
      appended.reverse();
      if (appended.some((entry) => entry.type === "compaction")) {
        if (!recovered)
          recovered = leaf
            ? messagesAtBoundary(
                manager.getBranch(),
                { leafId: leaf, compactionEntryId: basis },
                contextSessionId
              )
            : [];
        unmeasuredRecovery = true;
      }
      if (recovered && appended.length > 0)
        recovered = [
          ...recovered,
          ...appended
            .filter((entry) => entry.type !== "compaction")
            .flatMap(sessionEntryToContextMessages),
        ] as BotMessage[];
      leaf = currentLeaf;
      return recovered ?? (manager.buildSessionContext().messages as BotMessage[]);
    },
    boundary() {
      const leafId = manager.getLeafId();
      return leafId ? { leafId, compactionEntryId: basis } : undefined;
    },
    hasUnmeasuredRecovery: () => unmeasuredRecovery,
    acceptUsage() {
      unmeasuredRecovery = false;
    },
    acceptCompaction(entryId) {
      const entry = manager.getEntry(entryId);
      if (!entry || entry.type !== "compaction" || manager.getLeafId() !== entryId)
        return olderContext(contextSessionId);
      basis = entryId;
      leaf = entryId;
      recovered = undefined;
    },
  };
}
