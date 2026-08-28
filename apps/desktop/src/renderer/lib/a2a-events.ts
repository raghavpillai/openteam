import type { ChannelMessageView } from "@openbot/contracts";
import { shouldShowIdleGapTimestamp } from "./message-timestamps";

export interface A2AProjection {
  direction: "incoming" | "outgoing";
  peerId: string | null;
  peerName: string | null;
}

export interface A2AActivityEntry<T> {
  type: "a2a";
  id: string;
  createdAt: string;
  entries: T[];
  peerId: string | null;
  peerName: string | null;
}

export const a2aProjectionFor = (message: ChannelMessageView): A2AProjection | null => {
  if (
    !message.metadata ||
    typeof message.metadata !== "object" ||
    Array.isArray(message.metadata)
  ) {
    return null;
  }
  const metadata = message.metadata as Record<string, unknown>;
  const direction = metadata.fromAgent ? "incoming" : metadata.toAgent ? "outgoing" : null;
  if (!direction) return null;
  const peer = direction === "incoming" ? metadata.fromAgent : metadata.toAgent;
  const peerRecord =
    peer && typeof peer === "object" && !Array.isArray(peer)
      ? (peer as Record<string, unknown>)
      : null;
  return {
    direction,
    peerId: typeof peerRecord?.id === "string" ? peerRecord.id : null,
    peerName: typeof peerRecord?.name === "string" ? peerRecord.name : null,
  };
};

const samePeer = (left: A2AProjection, right: A2AProjection) =>
  left.peerId && right.peerId ? left.peerId === right.peerId : left.peerName === right.peerName;

export function collapseA2ATimeline<T extends { id: string; createdAt: string }>(
  entries: readonly T[],
  messageFor: (entry: T) => ChannelMessageView | null
): Array<T | A2AActivityEntry<T>> {
  const collapsed: Array<T | A2AActivityEntry<T>> = [];
  const active = new Map<
    string,
    A2AActivityEntry<T> & { projection: A2AProjection; lastCreatedAt: string }
  >();

  for (const entry of entries) {
    const message = messageFor(entry);
    const projection = message ? a2aProjectionFor(message) : null;
    if (!projection) {
      collapsed.push(entry);
      continue;
    }
    const peerKey = projection.peerId ?? projection.peerName;
    const key = peerKey ? `peer:${peerKey}` : `message:${entry.id}`;
    const current = active.get(key);
    if (
      current &&
      samePeer(current.projection, projection) &&
      !shouldShowIdleGapTimestamp(current.lastCreatedAt, entry.createdAt)
    ) {
      current.entries.push(entry);
      current.lastCreatedAt = entry.createdAt;
      continue;
    }
    const next = {
      type: "a2a",
      id: `a2a:${entry.id}`,
      createdAt: entry.createdAt,
      entries: [entry],
      peerId: projection.peerId,
      peerName: projection.peerName,
      projection,
      lastCreatedAt: entry.createdAt,
    } satisfies A2AActivityEntry<T> & {
      projection: A2AProjection;
      lastCreatedAt: string;
    };
    active.set(key, next);
    collapsed.push(next);
  }

  return collapsed;
}
