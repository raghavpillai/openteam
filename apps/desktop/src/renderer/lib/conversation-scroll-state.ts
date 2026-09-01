export interface ConversationScrollState {
  bottomDistance: number;
  historyGeneration: number;
  messageId: string | null;
  viewportOffset: number;
}

export type ConversationScrollRestore =
  | { kind: "latest" }
  | { index: number; kind: "message"; viewportOffset: number };

/** Resolve identity-based restoration, explicitly falling back to latest. */
export const resolveConversationScrollRestore = ({
  currentGeneration,
  messageIds,
  stored,
}: {
  currentGeneration: number;
  messageIds: readonly (string | null)[];
  stored: ConversationScrollState | undefined;
}): ConversationScrollRestore => {
  if (
    !stored ||
    stored.bottomDistance <= 2 ||
    stored.historyGeneration !== currentGeneration ||
    !stored.messageId
  ) {
    return { kind: "latest" };
  }
  const index = messageIds.indexOf(stored.messageId);
  return index < 0
    ? { kind: "latest" }
    : { index, kind: "message", viewportOffset: stored.viewportOffset };
};
