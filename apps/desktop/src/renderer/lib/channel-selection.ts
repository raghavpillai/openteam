import type { ChannelView } from "@openteam/contracts";

export const activeAgentIdForChannel = (channel: ChannelView | undefined): string | null => {
  if (!channel) return null;
  return (
    channel.directKey?.match(/^bot:(.+)$/)?.[1] ?? (channel.kind === "group" ? channel.id : null)
  );
};

export const restoredActiveChannelId = (input: {
  activeAgentId: string | null;
  channels: readonly ChannelView[];
  currentSelectedId: string | null;
  selectionRevisionAtRequest: number;
  currentSelectionRevision: number;
}): string | null => {
  if (input.currentSelectionRevision !== input.selectionRevisionAtRequest) {
    return input.currentSelectedId;
  }
  return (
    (input.activeAgentId
      ? input.channels.find(
          (channel) =>
            channel.directKey === `bot:${input.activeAgentId}` || channel.id === input.activeAgentId
        )?.id
      : null) ?? input.currentSelectedId
  );
};
