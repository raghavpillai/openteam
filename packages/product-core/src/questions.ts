import type { ChannelMessageView } from "@openteam/contracts";

const questionMetadata = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Conversation-local question state, including optimistic messages. Never mutate
 * cached server rows: removing a failed/unsent message must restore its question.
 * Persisted settlements win, so an older history page cannot reactivate a card.
 */
export const projectQuestionLifecycle = <T extends ChannelMessageView>(
  messages: readonly T[]
): T[] => {
  const boundaries = new Set<string>();
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
  for (let index = result.length - 1; index >= 0; index--) {
    const message = result[index]!;
    const metadata = questionMetadata(message.metadata);
    const scope = scopeOf(message);
    if (message.sender === "user") {
      boundaries.add(scope);
      continue;
    }
    if (message.sender !== "agent" || metadata.type !== "widget") continue;
    if (typeof metadata.respondedValue === "string" || metadata.widgetDismissed === true) {
      boundaries.add(scope);
    } else if (boundaries.has(scope)) {
      result[index] = {
        ...message,
        metadata: {
          ...metadata,
          widgetDismissed: true,
          widgetDismissalReason: "moved-on",
        },
      };
    }
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
