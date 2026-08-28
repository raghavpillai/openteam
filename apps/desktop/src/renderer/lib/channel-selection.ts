import type { ChannelView } from "@openbot/contracts";

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
      ? input.channels.find((channel) => channel.directKey === `bot:${input.activeAgentId}`)?.id
      : null) ?? input.currentSelectedId
  );
};
