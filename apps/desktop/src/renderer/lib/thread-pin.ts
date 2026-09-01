import type { ChannelMessageView } from "@openbot/contracts";
import { compareEntitySequence } from "@openbot/product-core/history";
import { messageRetainedByteSize } from "@openbot/product-core/message-window";

export const THREAD_TRAY_PIN_MAX_MESSAGES = 100;
export const THREAD_TRAY_PIN_MAX_RETAINED_BYTES = 512 * 1024;

export interface ThreadTrayPin {
  latestReplyId: string | null;
  replies: ChannelMessageView[];
  retainedBytes: number;
  root: ChannelMessageView;
  truncated: boolean;
}

/**
 * Keep an open thread usable even when its source history lane is rebalanced.
 * Live authoritative objects replace pinned copies by ID. The payload snapshot
 * is a newest-reply suffix under an explicit count/byte ceiling; the latest
 * reply ID is retained separately so submit never silently falls back to root.
 */
export const mergeThreadTrayPin = ({
  previous,
  replies,
  root,
  truncated = false,
}: {
  previous?: ThreadTrayPin | null;
  replies: readonly ChannelMessageView[];
  root: ChannelMessageView;
  truncated?: boolean;
}): ThreadTrayPin => {
  const replyById = new Map<string, ChannelMessageView>();
  for (const reply of previous?.replies ?? []) replyById.set(reply.id, reply);
  for (const reply of replies) replyById.set(reply.id, reply);
  replyById.delete(root.id);
  const candidates = [...replyById.values()].sort(compareEntitySequence);
  const latestReplyId = candidates.at(-1)?.id ?? previous?.latestReplyId ?? null;
  let retainedBytes = messageRetainedByteSize(root);
  let wasTruncated = truncated || previous?.truncated === true;
  const selected: ChannelMessageView[] = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const reply = candidates[index];
    if (!reply) continue;
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
  selected.reverse();
  return {
    latestReplyId,
    replies: selected,
    retainedBytes,
    root,
    truncated: wasTruncated,
  };
};
