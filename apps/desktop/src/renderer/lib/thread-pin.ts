import type { ChannelMessageView } from "@openteam/contracts";
import { compareEntitySequence } from "@openteam/product-core/history";
import { messageRetainedByteSize } from "@openteam/product-core/message-window";

export const THREAD_TRAY_PIN_MAX_MESSAGES = 100;
export const THREAD_TRAY_PIN_MAX_RETAINED_BYTES = 512 * 1024;

export interface ThreadTrayPin {
  latestReplyId: string | null;
  latestReplySequence: string | null;
  replies: ChannelMessageView[];
  retainedBytes: number;
  root: ChannelMessageView;
  truncated: boolean;
}

/**
 * Keep an open thread usable even when its source history lane is rebalanced.
 * Live authoritative objects replace pinned copies by ID. The payload snapshot
 * is a newest-reply suffix, or a window around a search result, under an explicit
 * count/byte ceiling. The latest reply ID is retained separately so submit
 * never silently falls back to root.
 */
export const mergeThreadTrayPin = ({
  previous,
  replies,
  root,
  truncated = false,
  focusMessageId,
}: {
  previous?: ThreadTrayPin | null;
  replies: readonly ChannelMessageView[];
  root: ChannelMessageView;
  truncated?: boolean;
  focusMessageId?: string | null;
}): ThreadTrayPin => {
  const replyById = new Map<string, ChannelMessageView>();
  for (const reply of previous?.replies ?? []) replyById.set(reply.id, reply);
  for (const reply of replies) replyById.set(reply.id, reply);
  replyById.delete(root.id);
  const candidates = [...replyById.values()].sort(compareEntitySequence);
  const newest = candidates.at(-1);
  const retainPreviousLatest =
    previous?.latestReplySequence != null &&
    (!newest || compareEntitySequence(newest, { sequence: previous.latestReplySequence }) < 0);
  const latestReplyId = retainPreviousLatest ? previous.latestReplyId : (newest?.id ?? null);
  const latestReplySequence = retainPreviousLatest
    ? previous.latestReplySequence
    : (newest?.sequence ?? null);
  let retainedBytes = messageRetainedByteSize(root);
  let wasTruncated = truncated || previous?.truncated === true;
  const selected: ChannelMessageView[] = [];
  const focusIndex = focusMessageId
    ? candidates.findIndex((reply) => reply.id === focusMessageId)
    : -1;
  // Retain a contiguous neighborhood around a distant result. The submit target
  // remains the newest known reply even when it lies outside this snapshot.
  const ordered =
    focusIndex < 0
      ? [...candidates].reverse()
      : candidates
          .map((reply, index) => ({ reply, distance: Math.abs(index - focusIndex), index }))
          .sort((a, b) => a.distance - b.distance || a.index - b.index)
          .map(({ reply }) => reply);
  for (const reply of ordered) {
    const replyBytes = messageRetainedByteSize(reply);
    if (
      selected.length + 2 > THREAD_TRAY_PIN_MAX_MESSAGES ||
      retainedBytes + replyBytes > THREAD_TRAY_PIN_MAX_RETAINED_BYTES
    ) {
      wasTruncated = true;
      break;
    }
    selected.push(reply);
    retainedBytes += replyBytes;
  }
  if (selected.length < candidates.length) wasTruncated = true;
  selected.sort(compareEntitySequence);
  return {
    latestReplyId,
    latestReplySequence,
    replies: selected,
    retainedBytes,
    root,
    truncated: wasTruncated,
  };
};
