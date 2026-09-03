import type { ChannelMessageView } from "@openteam/contracts";
import { compareEntitySequence, sortedUniqueMessages } from "./history";
import { replyTargetId } from "./messages";

const utf8 = new TextEncoder();
// ChannelMessageView snapshots are treated as immutable throughout the clients. Cache by object
// identity so repeated union rebalancing does not stringify and UTF-8 encode the same payload on
// every pass; a patched message is represented by a new object and therefore receives a new entry.
const retainedByteSizeByMessage = new WeakMap<ChannelMessageView, number>();

/** Which chronological edge remains canonical when a message window is trimmed. */
export type MessageWindowRetentionEdge = "oldest" | "newest";

export interface MessageWindowGapState {
  older: boolean;
  newer: boolean;
}

export interface MessageWindowEdgeEviction {
  count: number;
  /** The evicted message immediately across the gap from the retained window. */
  adjacentEvictedMessageId: string;
  /** The retained primary message immediately across the gap. */
  boundaryRetainedMessageId: string;
}

export interface MessageWindowEviction {
  older: MessageWindowEdgeEviction | null;
  newer: MessageWindowEdgeEviction | null;
}

export interface BoundMessageWindowOptions {
  /** Maximum primary-lane messages before protected messages create a soft excess. */
  maxMessages: number;
  /** Maximum UTF-8 JSON bytes across primary and required context messages. */
  maxBytes: number;
  /** Keep this chronological edge and evict from the opposite edge. */
  retain: MessageWindowRetentionEdge;
  /** Messages that must survive trimming, such as an anchor, target, or pending send. */
  protectedIds?: ReadonlySet<string>;
  /** Candidate reply ancestors/roots outside the primary lane. */
  threadContext?: readonly ChannelMessageView[];
  /** Gaps that existed before this trim operation. */
  existingGaps?: Partial<MessageWindowGapState>;
}

export interface MessageWindowSoftExcess {
  messages: number;
  bytes: number;
  /** A protected ID forced the contiguous primary window past a configured limit. */
  protected: boolean;
  /** One indivisible message (plus any required ancestry) exceeded the byte limit. */
  oversized: boolean;
}

export interface BoundMessageWindowResult {
  /** Chronological, unique, contiguous primary messages. */
  messages: ChannelMessageView[];
  /** Required reply ancestors/roots that sit outside the primary window. */
  threadContext: ChannelMessageView[];
  primaryBytes: number;
  contextBytes: number;
  retainedBytes: number;
  eviction: MessageWindowEviction;
  gaps: MessageWindowGapState;
  softExcess: MessageWindowSoftExcess;
  /** Protected IDs not present in either supplied lane. */
  missingProtectedIds: string[];
  /** Referenced ancestor IDs not present in either supplied lane. */
  missingAncestorIds: string[];
}

export type MessageViewportFillDirection = "older-first" | "newer-first";

export interface BoundMessageViewportWindowOptions
  extends Omit<BoundMessageWindowOptions, "protectedIds" | "retain"> {
  /** Actual message IDs intersecting the viewport at the time paging began. */
  viewportMessageIds: ReadonlySet<string>;
  /** Which adjacent side gets the remaining budget first. */
  fill: MessageViewportFillDirection;
}

/** Exact retained-payload proxy used by the history window's byte budget. */
export const messageRetainedByteSize = (message: ChannelMessageView): number => {
  const cached = retainedByteSizeByMessage.get(message);
  if (cached !== undefined) return cached;
  const measured = utf8.encode(JSON.stringify(message)).byteLength;
  retainedByteSizeByMessage.set(message, measured);
  return measured;
};

const normalizedMessages = (messages: readonly ChannelMessageView[]): ChannelMessageView[] =>
  sortedUniqueMessages(messages).sort(compareEntitySequence);

const assertLimit = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
};

/**
 * Bound one chronological message lane without creating an internal hole.
 *
 * Count applies to primary messages. The byte limit applies to primary messages plus the reply
 * ancestry needed to render them. Protected messages and one indivisible oversized message are
 * retained as a deliberate soft excess so trimming never breaks the visible anchor or a send.
 */
export const boundMessageWindow = (
  input: readonly ChannelMessageView[],
  options: BoundMessageWindowOptions
): BoundMessageWindowResult => {
  assertLimit(options.maxMessages, "maxMessages");
  assertLimit(options.maxBytes, "maxBytes");

  const messages = normalizedMessages(input);
  const contextCandidates = normalizedMessages(options.threadContext ?? []);
  const allById = new Map<string, ChannelMessageView>();
  for (const message of contextCandidates) allById.set(message.id, message);
  for (const message of messages) allById.set(message.id, message);

  const byteSizeById = new Map<string, number>();
  const byteSize = (id: string): number => {
    const cached = byteSizeById.get(id);
    if (cached !== undefined) return cached;
    const message = allById.get(id);
    const measured = message ? messageRetainedByteSize(message) : 0;
    byteSizeById.set(id, measured);
    return measured;
  };

  const protectedIds = options.protectedIds ?? new Set<string>();
  const missingProtectedIds = [...protectedIds]
    .filter((id) => !allById.has(id))
    .sort((left, right) => left.localeCompare(right));
  const primaryIndexById = new Map(messages.map((message, index) => [message.id, index] as const));
  const protectedPrimaryIndexes = [...protectedIds].flatMap((id) => {
    const index = primaryIndexById.get(id);
    return index === undefined ? [] : [index];
  });
  const requiredBoundary =
    protectedPrimaryIndexes.length === 0
      ? null
      : options.retain === "newest"
        ? Math.min(...protectedPrimaryIndexes)
        : Math.max(...protectedPrimaryIndexes);

  const selectedIds = new Set<string>();
  const retainedIds = new Set<string>();
  const missingAncestorIds = new Set<string>();
  let retainedBytes = 0;
  let protectionCausedExcess = false;

  const additionsFor = (id: string): { ids: string[]; missing: string[]; bytes: number } => {
    const additions: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>([id]);
    let currentId: string | null = id;
    while (currentId) {
      if (!retainedIds.has(currentId)) additions.push(currentId);
      const current = allById.get(currentId);
      const parentId = current ? replyTargetId(current) : null;
      if (!parentId || retainedIds.has(parentId)) break;
      if (seen.has(parentId)) break;
      seen.add(parentId);
      if (!allById.has(parentId)) {
        missing.push(parentId);
        break;
      }
      currentId = parentId;
    }
    return {
      ids: additions,
      missing,
      bytes: additions.reduce((total, addition) => total + byteSize(addition), 0),
    };
  };

  const commit = (id: string, additions: ReturnType<typeof additionsFor>): void => {
    selectedIds.add(id);
    for (const addition of additions.ids) retainedIds.add(addition);
    for (const missing of additions.missing) missingAncestorIds.add(missing);
    retainedBytes += additions.bytes;
  };

  // Protected supplemental context is always retained and participates in the byte accounting.
  for (const id of [...protectedIds].sort((left, right) => left.localeCompare(right))) {
    if (primaryIndexById.has(id) || !allById.has(id)) continue;
    const additions = additionsFor(id);
    if (retainedBytes + additions.bytes > options.maxBytes) protectionCausedExcess = true;
    for (const addition of additions.ids) retainedIds.add(addition);
    for (const missing of additions.missing) missingAncestorIds.add(missing);
    retainedBytes += additions.bytes;
  }

  const startIndex = options.retain === "newest" ? messages.length - 1 : 0;
  const endIndex = options.retain === "newest" ? -1 : messages.length;
  const step = options.retain === "newest" ? -1 : 1;
  for (let index = startIndex; index !== endIndex; index += step) {
    const message = messages[index];
    if (!message) continue;
    const additions = additionsFor(message.id);
    const nextCount = selectedIds.size + 1;
    const nextBytes = retainedBytes + additions.bytes;
    const requiredForProtection =
      requiredBoundary !== null &&
      (options.retain === "newest" ? index >= requiredBoundary : index <= requiredBoundary);
    const firstPrimary = selectedIds.size === 0;
    if (
      !firstPrimary &&
      !requiredForProtection &&
      (nextCount > options.maxMessages || nextBytes > options.maxBytes)
    ) {
      break;
    }
    if (
      requiredForProtection &&
      (nextCount > options.maxMessages || nextBytes > options.maxBytes)
    ) {
      protectionCausedExcess = true;
    }
    commit(message.id, additions);
  }

  const selected = messages.filter((message) => selectedIds.has(message.id));
  const firstSelected = selected[0] ?? null;
  const lastSelected = selected.at(-1) ?? null;
  const selectedIndexStart = firstSelected
    ? (primaryIndexById.get(firstSelected.id) ?? messages.length)
    : messages.length;
  const selectedIndexEnd =
    lastSelected === null ? -1 : (primaryIndexById.get(lastSelected.id) ?? -1);
  const olderCount = selectedIndexStart;
  const newerCount = messages.length - selectedIndexEnd - 1;
  const adjacentOlder = messages[selectedIndexStart - 1] ?? null;
  const adjacentNewer = messages[selectedIndexEnd + 1] ?? null;
  const olderEviction =
    olderCount > 0 && firstSelected && adjacentOlder
      ? {
          count: olderCount,
          adjacentEvictedMessageId: adjacentOlder.id,
          boundaryRetainedMessageId: firstSelected.id,
        }
      : null;
  const newerEviction =
    newerCount > 0 && lastSelected && adjacentNewer
      ? {
          count: newerCount,
          adjacentEvictedMessageId: adjacentNewer.id,
          boundaryRetainedMessageId: lastSelected.id,
        }
      : null;

  const selectedIdSet = new Set(selected.map((message) => message.id));
  const threadContext = normalizedMessages(
    [...retainedIds].flatMap((id) => {
      const message = allById.get(id);
      return message && !selectedIdSet.has(id) ? [message] : [];
    })
  );
  const primaryBytes = selected.reduce((total, message) => total + byteSize(message.id), 0);
  const contextBytes = threadContext.reduce((total, message) => total + byteSize(message.id), 0);
  const excessMessages = Math.max(0, selected.length - options.maxMessages);
  const excessBytes = Math.max(0, retainedBytes - options.maxBytes);
  protectionCausedExcess &&= excessMessages > 0 || excessBytes > 0;
  const oversized = excessBytes > 0 && !protectionCausedExcess && selected.length === 1;

  return {
    messages: selected,
    threadContext,
    primaryBytes,
    contextBytes,
    retainedBytes,
    eviction: { older: olderEviction, newer: newerEviction },
    gaps: {
      older: options.existingGaps?.older === true || olderEviction !== null,
      newer: options.existingGaps?.newer === true || newerEviction !== null,
    },
    softExcess: {
      messages: excessMessages,
      bytes: excessBytes,
      protected: protectionCausedExcess,
      oversized,
    },
    missingProtectedIds,
    missingAncestorIds: [...missingAncestorIds].sort((left, right) => left.localeCompare(right)),
  };
};

/**
 * Bound a contiguous window around the rows that are actually visible.
 *
 * A regular protected edge window has to retain every row between that edge and
 * a protected anchor. That is the wrong shape for virtualized chat pagination:
 * one rich older page could otherwise turn an anchor near the old boundary into
 * a multi-megabyte edge-to-anchor soft excess. This two-pass pivot keeps only
 * the visible span mandatory, fills the requested adjacent direction first,
 * then spends any remaining count/byte budget on the opposite side.
 */
export const boundMessageWindowAroundViewport = (
  input: readonly ChannelMessageView[],
  options: BoundMessageViewportWindowOptions
): BoundMessageWindowResult => {
  const messages = normalizedMessages(input);
  const indexById = new Map(messages.map((message, index) => [message.id, index] as const));
  const viewportIndexes = [...options.viewportMessageIds].flatMap((id) => {
    const index = indexById.get(id);
    return index === undefined ? [] : [index];
  });
  const fallbackRetain = options.fill === "older-first" ? "oldest" : "newest";
  if (viewportIndexes.length === 0) {
    return boundMessageWindow(messages, {
      ...options,
      protectedIds: options.viewportMessageIds,
      retain: fallbackRetain,
    });
  }

  const firstViewportIndex = Math.min(...viewportIndexes);
  const lastViewportIndex = Math.max(...viewportIndexes);
  // Every primary message remains available as an ancestry candidate even
  // while each pass operates on just one side of the pivot.
  const ancestryCandidates = [...messages, ...(options.threadContext ?? [])];
  const firstPass =
    options.fill === "older-first"
      ? boundMessageWindow(messages.slice(0, lastViewportIndex + 1), {
          ...options,
          protectedIds: options.viewportMessageIds,
          retain: "newest",
          threadContext: ancestryCandidates,
        })
      : boundMessageWindow(messages.slice(firstViewportIndex), {
          ...options,
          protectedIds: options.viewportMessageIds,
          retain: "oldest",
          threadContext: ancestryCandidates,
        });
  const carriedProtectedIds = new Set([
    ...options.viewportMessageIds,
    ...firstPass.messages.map((message) => message.id),
  ]);
  const firstSelectedIndex = indexById.get(firstPass.messages[0]?.id ?? "") ?? firstViewportIndex;
  const lastSelectedIndex = indexById.get(firstPass.messages.at(-1)?.id ?? "") ?? lastViewportIndex;
  const bounded =
    options.fill === "older-first"
      ? boundMessageWindow(messages.slice(firstSelectedIndex), {
          ...options,
          protectedIds: carriedProtectedIds,
          retain: "oldest",
          threadContext: ancestryCandidates,
        })
      : boundMessageWindow(messages.slice(0, lastSelectedIndex + 1), {
          ...options,
          protectedIds: carriedProtectedIds,
          retain: "newest",
          threadContext: ancestryCandidates,
        });

  const firstSelected = bounded.messages[0] ?? null;
  const lastSelected = bounded.messages.at(-1) ?? null;
  const selectedStart = firstSelected ? (indexById.get(firstSelected.id) ?? messages.length) : 0;
  const selectedEnd = lastSelected ? (indexById.get(lastSelected.id) ?? -1) : -1;
  const adjacentOlder = messages[selectedStart - 1] ?? null;
  const adjacentNewer = messages[selectedEnd + 1] ?? null;
  const olderCount = firstSelected ? selectedStart : messages.length;
  const newerCount = lastSelected ? messages.length - selectedEnd - 1 : 0;
  const older =
    olderCount > 0 && firstSelected && adjacentOlder
      ? {
          count: olderCount,
          adjacentEvictedMessageId: adjacentOlder.id,
          boundaryRetainedMessageId: firstSelected.id,
        }
      : null;
  const newer =
    newerCount > 0 && lastSelected && adjacentNewer
      ? {
          count: newerCount,
          adjacentEvictedMessageId: adjacentNewer.id,
          boundaryRetainedMessageId: lastSelected.id,
        }
      : null;
  return {
    ...bounded,
    eviction: { older, newer },
    gaps: {
      older: options.existingGaps?.older === true || older !== null,
      newer: options.existingGaps?.newer === true || newer !== null,
    },
  };
};

export type LatestRefreshDisposition = "empty" | "initialize" | "merge" | "reset";

export interface LatestRefreshOverlap {
  disposition: LatestRefreshDisposition;
  overlaps: boolean;
  requiresReset: boolean;
  overlapIds: string[];
  retainedNewestMessageId: string | null;
  refreshOldestMessageId: string | null;
  refreshNewestMessageId: string | null;
}

/**
 * Classify a latest-page refresh using message identity, never sequence adjacency.
 * A non-empty refresh with no retained ID in common represents an explicit reconnect gap.
 */
export const latestRefreshOverlap = (
  retainedPrimary: readonly ChannelMessageView[],
  latestPage: readonly ChannelMessageView[]
): LatestRefreshOverlap => {
  const retained = normalizedMessages(retainedPrimary);
  const latest = normalizedMessages(latestPage);
  const retainedIds = new Set(retained.map((message) => message.id));
  const overlapIds = latest
    .filter((message) => retainedIds.has(message.id))
    .map((message) => message.id);
  const disposition: LatestRefreshDisposition =
    latest.length === 0
      ? "empty"
      : retained.length === 0
        ? "initialize"
        : overlapIds.length > 0
          ? "merge"
          : "reset";
  return {
    disposition,
    overlaps: overlapIds.length > 0,
    requiresReset: disposition === "reset",
    overlapIds,
    retainedNewestMessageId: retained.at(-1)?.id ?? null,
    refreshOldestMessageId: latest[0]?.id ?? null,
    refreshNewestMessageId: latest.at(-1)?.id ?? null,
  };
};
