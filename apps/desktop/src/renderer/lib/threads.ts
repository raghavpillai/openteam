import type { ChannelMessageView } from "@openbot/contracts";

const metadata = (message: ChannelMessageView): Record<string, unknown> =>
  message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};

export const isBranchedMessage = (message: ChannelMessageView): boolean =>
  metadata(message).branched === true;

export const replyTargetId = (message: ChannelMessageView): string | null => {
  const reply = metadata(message).replyTo;
  return typeof reply === "string" ? reply : null;
};

export interface ThreadView {
  root: ChannelMessageView;
  replies: ChannelMessageView[];
}

export const deriveThreads = (messages: readonly ChannelMessageView[]): Map<string, ThreadView> => {
  const byId = new Map(messages.map((message) => [message.id, message] as const));
  const repliesByRoot = new Map<string, ChannelMessageView[]>();
  for (const message of messages) {
    if (!isBranchedMessage(message)) continue;
    let targetId = replyTargetId(message);
    const visited = new Set<string>([message.id]);
    while (targetId) {
      if (visited.has(targetId)) break;
      visited.add(targetId);
      const target = byId.get(targetId);
      if (!target || !isBranchedMessage(target)) break;
      targetId = replyTargetId(target);
    }
    if (!targetId || !byId.has(targetId)) continue;
    const replies = repliesByRoot.get(targetId) ?? [];
    replies.push(message);
    repliesByRoot.set(targetId, replies);
  }
  return new Map(
    [...repliesByRoot.entries()].flatMap(([rootId, replies]) => {
      const root = byId.get(rootId);
      if (!root) return [];
      return [
        [
          rootId,
          {
            root,
            replies: replies.sort(
              (left, right) =>
                new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
                left.id.localeCompare(right.id)
            ),
          },
        ] as const,
      ];
    })
  );
};
