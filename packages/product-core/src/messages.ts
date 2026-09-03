import type {
  AssetKind,
  AssetRef,
  BotView,
  ChannelMessageView,
  ChannelView,
} from "@openteam/contracts";
import type { DurableStagedAttachment } from "./durable-delivery";
import { shouldShowIdleGapTimestamp } from "./timestamps";

export const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;

const ASSET_ID = /^[a-f0-9]{64}$/;
const ASSET_KINDS: ReadonlySet<AssetKind> = new Set([
  "image",
  "video",
  "audio",
  "pdf",
  "text",
  "file",
]);

export const messageMetadata = (message: ChannelMessageView): Record<string, unknown> =>
  message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};

export const parseAssetRef = (candidate: unknown): AssetRef | null => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const { assetId, fileName, mimeType, byteSize, kind, width, height, alt } = candidate as Record<
    string,
    unknown
  >;
  if (
    typeof assetId !== "string" ||
    !ASSET_ID.test(assetId) ||
    typeof fileName !== "string" ||
    fileName.length < 1 ||
    fileName.length > 255 ||
    typeof mimeType !== "string" ||
    mimeType.length < 1 ||
    mimeType.length > 120 ||
    typeof byteSize !== "number" ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 1 ||
    byteSize > 200 * 1024 * 1024 ||
    typeof kind !== "string" ||
    !ASSET_KINDS.has(kind as AssetKind) ||
    (width !== undefined &&
      (typeof width !== "number" || !Number.isSafeInteger(width) || width < 1)) ||
    (height !== undefined &&
      (typeof height !== "number" || !Number.isSafeInteger(height) || height < 1)) ||
    (alt !== undefined && (typeof alt !== "string" || alt.length > 2_000))
  ) {
    return null;
  }
  return {
    assetId,
    fileName,
    mimeType,
    byteSize,
    kind: kind as AssetKind,
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
    ...(typeof alt === "string" ? { alt } : {}),
  };
};

export const messageAssets = (message: ChannelMessageView): AssetRef[] => {
  const metadata = messageMetadata(message);
  const candidates = [
    ...(Array.isArray(metadata.attachments) ? metadata.attachments : []),
    ...(metadata.attachment ? [metadata.attachment] : []),
  ];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const asset = parseAssetRef(candidate);
    if (!asset) return [];
    const key = `${asset.assetId}:${asset.fileName}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [asset];
  });
};

export const messageStagedAttachments = (
  message: ChannelMessageView
): DurableStagedAttachment[] => {
  const candidates = messageMetadata(message).clientStagedAttachments;
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, 6).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const value = candidate as Partial<DurableStagedAttachment>;
    if (
      typeof value.stagingId !== "string" ||
      typeof value.fileName !== "string" ||
      typeof value.mimeType !== "string" ||
      typeof value.byteSize !== "number" ||
      typeof value.kind !== "string" ||
      !ASSET_KINDS.has(value.kind as AssetKind)
    ) {
      return [];
    }
    return [value as DurableStagedAttachment];
  });
};

export interface MessageReactionPill {
  emoji: string;
  count: number;
}

export const messageReactionPills = (message: ChannelMessageView): MessageReactionPill[] => {
  const reactions = messageMetadata(message).reactions;
  if (!Array.isArray(reactions)) return [];
  const counts = new Map<string, number>();
  for (const reaction of reactions) {
    if (!reaction || typeof reaction !== "object" || Array.isArray(reaction)) continue;
    const emoji = (reaction as Record<string, unknown>).emoji;
    if (typeof emoji === "string") counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  }
  return [...counts].map(([emoji, count]) => ({ emoji, count }));
};

export const ownReactionEmojiSet = (message: ChannelMessageView): ReadonlySet<string> => {
  const reactions = messageMetadata(message).reactions;
  if (!Array.isArray(reactions)) return new Set();
  return new Set(
    reactions.flatMap((reaction) => {
      if (!reaction || typeof reaction !== "object" || Array.isArray(reaction)) return [];
      const value = reaction as Record<string, unknown>;
      return value.by === "me" && typeof value.emoji === "string" ? [value.emoji] : [];
    })
  );
};

export interface ClientDeliveryProjection {
  acceptedAtMs: number | null;
  composedAtMs: number | null;
  inFlight: boolean;
  nonce: string | null;
  queuedAtMs: number | null;
  renderKey: string;
  state: "pending" | "queued" | "accepted" | "failed";
  transportDown: boolean;
}

export const clientDeliveryFor = (message: ChannelMessageView): ClientDeliveryProjection | null => {
  const candidate = messageMetadata(message).clientDelivery;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const {
    acceptedAtMs,
    composedAtMs,
    inFlight,
    nonce,
    queuedAtMs,
    renderKey,
    state,
    transportDown,
  } = candidate as Record<string, unknown>;
  return typeof renderKey === "string" &&
    (state === "pending" || state === "queued" || state === "accepted" || state === "failed")
    ? {
        acceptedAtMs: typeof acceptedAtMs === "number" ? acceptedAtMs : null,
        composedAtMs: typeof composedAtMs === "number" ? composedAtMs : null,
        inFlight: inFlight === true,
        nonce: typeof nonce === "string" ? nonce : null,
        queuedAtMs: typeof queuedAtMs === "number" ? queuedAtMs : null,
        renderKey,
        state,
        transportDown: transportDown === true,
      }
    : null;
};

export const messageRenderKey = (message: ChannelMessageView): string =>
  clientDeliveryFor(message)?.renderKey ??
  (message.sender === "user" && message.clientId ? `optimistic:${message.clientId}` : message.id);

export const channelMessageAddress = (message: ChannelMessageView): string => {
  if (message.sender === "user") return `t${message.sequence}u`;
  const address = messageMetadata(message).address;
  return typeof address === "string" ? address : `t${message.sequence}a0`;
};

export const replyTargetFor = (
  message: ChannelMessageView,
  messagesById: ReadonlyMap<string, ChannelMessageView>,
  messagesByAddress: ReadonlyMap<string, ChannelMessageView> = new Map()
): ChannelMessageView | null => {
  const metadata = messageMetadata(message);
  if (typeof metadata.replyTo === "string") {
    const target = messagesById.get(metadata.replyTo);
    if (target) return target;
  }
  const legacyAddress = typeof metadata.reply_to === "string" ? metadata.reply_to : null;
  return legacyAddress ? (messagesByAddress.get(legacyAddress) ?? null) : null;
};

export const messageSenderLabel = (
  message: Pick<ChannelMessageView, "sender" | "senderBotId"> & { metadata?: unknown },
  botById: ReadonlyMap<string, Pick<BotView, "name">>
): string => {
  const metadata =
    message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : {};
  const peer = metadata.fromAgent ?? metadata.toAgent;
  if (peer && typeof peer === "object" && !Array.isArray(peer)) {
    const name = (peer as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  if (message.sender === "user") return "You";
  if (message.sender === "system") return "System";
  return message.senderBotId ? (botById.get(message.senderBotId)?.name ?? "Bot") : "Bot";
};

export interface MessageDisplayProjection {
  attachments: AssetRef[];
  stagedAttachments: DurableStagedAttachment[];
  displayContent: string;
  files: AssetRef[];
  images: AssetRef[];
  richMessage: boolean;
}

export const messageDisplayProjection = (message: ChannelMessageView): MessageDisplayProjection => {
  const metadata = messageMetadata(message);
  const attachments = messageAssets(message);
  const stagedAttachments = messageStagedAttachments(message);
  const richMessage =
    metadata.type === "widget" ||
    metadata.type === "secret-request" ||
    metadata.type === "computer-handoff" ||
    metadata.type === "cloud-agent" ||
    metadata.type === "cloud_agent" ||
    metadata.type === "cloud-agent-card" ||
    metadata.type === "bot-template";
  const attachmentOnly =
    (metadata.type === "attachment" || Boolean(metadata.attachment)) &&
    attachments.length > 0 &&
    (metadata.type === "attachment" ||
      (attachments.length === 1 && message.content === attachments[0]?.fileName));
  return {
    attachments,
    stagedAttachments,
    displayContent: attachmentOnly || richMessage ? "" : message.content,
    files: attachments.filter((attachment) => attachment.kind !== "image"),
    images: attachments.filter((attachment) => attachment.kind === "image"),
    richMessage,
  };
};

export const toggleOwnReaction = (
  message: ChannelMessageView,
  emoji: string
): ChannelMessageView => {
  const metadata = messageMetadata(message);
  const reactions = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];
  const isOwnReaction = (reaction: unknown): boolean =>
    Boolean(reaction) &&
    typeof reaction === "object" &&
    !Array.isArray(reaction) &&
    (reaction as { by?: unknown }).by === "me" &&
    (reaction as { emoji?: unknown }).emoji === emoji;
  const alreadyReacted = reactions.some(isOwnReaction);
  return {
    ...message,
    metadata: {
      ...metadata,
      reactions: alreadyReacted
        ? reactions.filter((reaction) => !isOwnReaction(reaction))
        : [...reactions, { by: "me", emoji }],
    },
  };
};

const numericSequence = (value: string | null | undefined): bigint | null =>
  value && /^\d+$/.test(value) ? BigInt(value) : null;

/** Whether a partially loaded newest-first history may still hide replies to this root. */
export const mayHaveEarlierThreadReplies = (
  rootSequence: string,
  beforeSequence: string | null | undefined,
  channelHistoryHasMore: boolean
): boolean => {
  if (!channelHistoryHasMore) return false;
  const root = numericSequence(rootSequence);
  const before = numericSequence(beforeSequence);
  return root === null || before === null || before > root;
};

export const threadReplyCountLabel = (count: number, partial: boolean): string => {
  const boundedCount = Math.max(0, Math.trunc(count));
  return `${boundedCount}${partial ? " loaded" : ""} ${boundedCount === 1 ? "reply" : "replies"}`;
};

export interface A2AProjection {
  direction: "incoming" | "outgoing";
  peerId: string | null;
  peerName: string | null;
}

export const a2aProjectionFor = (message: ChannelMessageView): A2AProjection | null => {
  const metadata = messageMetadata(message);
  const direction = metadata.fromAgent ? "incoming" : metadata.toAgent ? "outgoing" : null;
  if (!direction) return null;
  const candidate = direction === "incoming" ? metadata.fromAgent : metadata.toAgent;
  const peer =
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : null;
  return {
    direction,
    peerId: typeof peer?.id === "string" ? peer.id : null,
    peerName: typeof peer?.name === "string" ? peer.name : null,
  };
};

export const selectA2AExchangeMessages = (
  messages: readonly ChannelMessageView[],
  peerId: string
): ChannelMessageView[] =>
  messages.filter((message) => a2aProjectionFor(message)?.peerId === peerId);

export const deriveA2AExchange = (input: {
  source: BotView;
  peer: BotView;
  sourceChannel: ChannelView;
  sourceMessages: readonly ChannelMessageView[];
}): { channel: ChannelView; messages: ChannelMessageView[] } => {
  const id = `a2a:${input.source.id}:${input.peer.id}`;
  const messages = selectA2AExchangeMessages(input.sourceMessages, input.peer.id).map(
    (message) => ({
      ...message,
      channelId: id,
      sender: "agent" as const,
      senderBotId:
        a2aProjectionFor(message)?.direction === "incoming" ? input.peer.id : input.source.id,
    })
  );
  return {
    channel: {
      id,
      kind: "agent_dm",
      name: `${input.source.name} ↔ ${input.peer.name}`,
      description: "",
      hasAvatar: false,
      directKey: `agents:${[input.source.id, input.peer.id].sort().join(":")}`,
      workingDirectory: null,
      members: [
        { botId: input.source.id, ordinal: 0 },
        { botId: input.peer.id, ordinal: 1 },
      ],
      createdAt: input.sourceChannel.createdAt,
      updatedAt: messages.at(-1)?.createdAt ?? input.sourceChannel.updatedAt,
    },
    messages,
  };
};

export interface A2AActivityEntry<T> {
  type: "a2a";
  id: string;
  createdAt: string;
  entries: T[];
  peerId: string | null;
  peerName: string | null;
}

const samePeer = (left: A2AProjection, right: A2AProjection) =>
  left.peerId && right.peerId ? left.peerId === right.peerId : left.peerName === right.peerName;

export const collapseA2ATimeline = <T extends { id: string; createdAt: string }>(
  entries: readonly T[],
  messageFor: (entry: T) => ChannelMessageView | null
): Array<T | A2AActivityEntry<T>> => {
  type ActiveA2A = A2AActivityEntry<T> & {
    projection: A2AProjection;
    lastCreatedAt: string;
  };
  const collapsed: Array<T | A2AActivityEntry<T>> = [];
  let active: ActiveA2A | null = null;
  let activeKey: string | null = null;
  for (const entry of entries) {
    const message = messageFor(entry);
    const projection = message ? a2aProjectionFor(message) : null;
    if (!projection) {
      active = null;
      activeKey = null;
      collapsed.push(entry);
      continue;
    }
    const peerKey = projection.peerId ?? projection.peerName;
    const key = peerKey ? `peer:${peerKey}` : `message:${entry.id}`;
    if (
      active &&
      activeKey === key &&
      samePeer(active.projection, projection) &&
      !shouldShowIdleGapTimestamp(active.lastCreatedAt, entry.createdAt)
    ) {
      active.entries.push(entry);
      active.lastCreatedAt = entry.createdAt;
      continue;
    }
    const next: ActiveA2A = {
      type: "a2a",
      id: `a2a:${entry.id}`,
      createdAt: entry.createdAt,
      entries: [entry],
      peerId: projection.peerId,
      peerName: projection.peerName,
      projection,
      lastCreatedAt: entry.createdAt,
    };
    active = next;
    activeKey = key;
    collapsed.push(next);
  }
  return collapsed;
};

export const isBranchedMessage = (message: ChannelMessageView): boolean =>
  messageMetadata(message).branched === true;

export const replyTargetId = (message: ChannelMessageView): string | null => {
  const reply = messageMetadata(message).replyTo;
  return typeof reply === "string" ? reply : null;
};

export interface ThreadView {
  root: ChannelMessageView;
  replies: ChannelMessageView[];
}

const threadRootIds = (
  messages: readonly ChannelMessageView[],
  byId: ReadonlyMap<string, ChannelMessageView>
) => {
  const resolved = new Map<string, string | null>();
  for (const message of messages) {
    if (!isBranchedMessage(message) || resolved.has(message.id)) continue;
    const path: string[] = [];
    const pathIds = new Set<string>();
    let current: ChannelMessageView | undefined = message;
    let rootId: string | null = null;
    while (current && isBranchedMessage(current)) {
      if (resolved.has(current.id)) {
        rootId = resolved.get(current.id) ?? null;
        break;
      }
      if (pathIds.has(current.id)) break;
      pathIds.add(current.id);
      path.push(current.id);
      const targetId = replyTargetId(current);
      if (!targetId) break;
      const target = byId.get(targetId);
      if (!target) break;
      if (!isBranchedMessage(target)) {
        rootId = target.id;
        break;
      }
      current = target;
    }
    for (const id of path) resolved.set(id, rootId);
  }
  return resolved;
};

export const deriveThreads = (messages: readonly ChannelMessageView[]): Map<string, ThreadView> => {
  const byId = new Map(messages.map((message) => [message.id, message] as const));
  const rootByReplyId = threadRootIds(messages, byId);
  const repliesByRoot = new Map<string, ChannelMessageView[]>();
  for (const message of messages) {
    if (!isBranchedMessage(message)) continue;
    const rootId = rootByReplyId.get(message.id);
    if (!rootId) continue;
    const replies = repliesByRoot.get(rootId) ?? [];
    replies.push(message);
    repliesByRoot.set(rootId, replies);
  }
  return new Map(
    [...repliesByRoot.entries()].flatMap(([rootId, replies]) => {
      const root = byId.get(rootId);
      return root
        ? [
            [
              rootId,
              {
                root,
                replies: replies.sort(
                  (left, right) =>
                    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
                    left.id.localeCompare(right.id)
                ),
              },
            ] as const,
          ]
        : [];
    })
  );
};

/** Assign deterministic, collision-free render keys while preserving duplicate values. */
export const withStableOccurrenceKeys = <Value>(
  values: readonly Value[],
  fingerprintFor: (value: Value) => string
): Array<{ value: Value; key: string }> => {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const fingerprint = fingerprintFor(value);
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);
    return { value, key: `${fingerprint}:${occurrence}` };
  });
};
