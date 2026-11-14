import type { ChannelMessageView } from "@openteam/contracts";

const questionMetadata = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const receiptKeys = [
  "respondedValue",
  "respondedLabel",
  "widgetDismissed",
  "widgetDismissalReason",
  "widgetDismissClientId",
  "widgetResponseClientId",
] as const;
const receiptFor = (message: ChannelMessageView): Record<string, unknown> | null => {
  const metadata = questionMetadata(message.metadata);
  return metadata.type === "widget" &&
    (typeof metadata.respondedValue === "string" || metadata.widgetDismissed === true)
    ? Object.fromEntries(
        receiptKeys.filter((key) => key in metadata).map((key) => [key, metadata[key]])
      )
    : null;
};
const restoreReceipt = <T extends ChannelMessageView>(
  message: T,
  receipt: Record<string, unknown>
): T => {
  const previous = questionMetadata(message.metadata);
  if (receiptKeys.every((key) => previous[key] === receipt[key])) return message;
  const metadata = { ...previous };
  for (const key of receiptKeys) {
    delete metadata[key];
    if (key in receipt) metadata[key] = receipt[key];
  }
  return { ...message, metadata };
};

export const preserveQuestionReceipt = <T extends ChannelMessageView>(
  previous: T,
  incoming: T
): T => {
  const receipt = receiptFor(previous);
  return receipt ? restoreReceipt(incoming, receipt) : incoming;
};

/** Small, channel-lifetime tombstones survive window replacement without retaining card bodies.
 * Bounded independently from visible history; deleting a channel/account drops these too.
 */
export const createQuestionReceiptStore = (limit = 500, maxBytes = 256 * 1024) => {
  limit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 500;
  maxBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.trunc(maxBytes)) : 256 * 1024;
  const receipts = new Map<string, { metadata: Record<string, unknown>; bytes: number }>();
  let bytes = 0;
  const keyOf = (message: ChannelMessageView) => `${message.channelId}:${message.id}`;
  return {
    get size() {
      return receipts.size;
    },
    get bytes() {
      return bytes;
    },
    remember(messages: readonly ChannelMessageView[]) {
      for (const message of messages) {
        const key = keyOf(message);
        if (receipts.has(key)) continue;
        const metadata = receiptFor(message);
        if (!metadata) continue;
        const size = 128 + 2 * (key.length + JSON.stringify(metadata).length);
        receipts.set(key, { metadata, bytes: size });
        bytes += size;
        while (receipts.size > limit || bytes > maxBytes) {
          const oldest = receipts.keys().next().value!;
          bytes -= receipts.get(oldest)!.bytes;
          receipts.delete(oldest);
        }
      }
    },
    restore<T extends ChannelMessageView>(message: T): T {
      const receipt = receipts.get(keyOf(message));
      return receipt ? restoreReceipt(message, receipt.metadata) : message;
    },
  };
};

/** Conversation-local question state, including optimistic messages. Never mutate
 * cached server rows: removing a failed/unsent message must restore its question.
 * Persisted settlements win, so an older history page cannot reactivate a card.
 */
export const projectQuestionLifecycle = <T extends ChannelMessageView>(
  messages: readonly T[]
): T[] => {
  const boundaries = new Map<string, "moved-on" | "superseded">();
  const byId = new Map(messages.map((message) => [message.id, message]));
  const scopeOf = (message: ChannelMessageView): string => {
    const metadata = questionMetadata(message.metadata);
    if (metadata.branched !== true) return `${message.channelId}:main`;
    if (typeof metadata.questionScopeId === "string")
      return `${message.channelId}:${metadata.questionScopeId}`;
    const replyId = String(metadata.replyTo ?? message.id);
    const parent = byId.get(replyId);
    const parentMetadata = parent ? questionMetadata(parent.metadata) : {};
    return `${message.channelId}:${parentMetadata.questionScopeId ?? replyId}`;
  };
  const result = [...messages];
  const optimistic = new Map<string, number>();
  const accepted = messages
    .flatMap((message, index) => {
      if (/^\d+$/.test(message.sequence)) return [{ index, sequence: BigInt(message.sequence) }];
      if (message.sender === "user") {
        const scope = scopeOf(message),
          date = Date.parse(message.createdAt);
        if (Number.isFinite(date))
          optimistic.set(scope, Math.max(optimistic.get(scope) ?? -Infinity, date));
      }
      return [];
    })
    .sort((a, b) =>
      a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : a.index - b.index
    );
  for (const { index } of accepted.reverse()) {
    const message = messages[index]!;
    const metadata = questionMetadata(message.metadata);
    const scope = scopeOf(message);
    if (message.sender === "user") {
      boundaries.set(scope, "moved-on");
      continue;
    }
    if (message.sender !== "agent" || metadata.type !== "widget") continue;
    if (typeof metadata.respondedValue === "string" || metadata.widgetDismissed === true) {
      boundaries.set(scope, "superseded");
    } else if (
      boundaries.has(scope) ||
      (optimistic.get(scope) ?? -Infinity) >= Date.parse(message.createdAt)
    ) {
      result[index] = {
        ...message,
        metadata: {
          ...metadata,
          widgetDismissed: true,
          widgetDismissalReason: boundaries.get(scope) ?? "moved-on",
        },
      };
    } else boundaries.set(scope, "superseded");
  }
  return result;
};

export const currentQuestion = (
  messages: readonly ChannelMessageView[]
): ChannelMessageView | null =>
  projectQuestionLifecycle(messages).findLast((message) => {
    const metadata = questionMetadata(message.metadata);
    return (
      message.sender === "agent" &&
      metadata.type === "widget" &&
      metadata.branched !== true &&
      typeof metadata.respondedValue !== "string" &&
      metadata.widgetDismissed !== true
    );
  }) ?? null;
