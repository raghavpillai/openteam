import type { BotView, ChannelMessageView, ChannelView } from "@openbot/contracts";

export type A2AExchangePhase = "entering" | "open" | "exiting";

export interface A2AExchangeState {
  sourceChannelId: string;
  sourceBotId: string;
  peerId: string;
  phase: A2AExchangePhase;
}

export const startA2AExchange = (
  sourceChannelId: string,
  sourceBotId: string,
  peerId: string
): A2AExchangeState => ({
  sourceChannelId,
  sourceBotId,
  peerId,
  phase: "entering",
});

export const closeA2AExchange = (state: A2AExchangeState): A2AExchangeState =>
  state.phase === "exiting" ? state : { ...state, phase: "exiting" };

export const finishA2AExchangeAnimation = (state: A2AExchangeState): A2AExchangeState | null => {
  if (state.phase === "entering") return { ...state, phase: "open" };
  if (state.phase === "exiting") return null;
  return state;
};

const metadataRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const peerIdFor = (message: ChannelMessageView): string | null => {
  const metadata = metadataRecord(message.metadata);
  const peer = metadataRecord(metadata?.fromAgent ?? metadata?.toAgent);
  return typeof peer?.id === "string" ? peer.id : null;
};

const isIncoming = (message: ChannelMessageView): boolean =>
  Boolean(metadataRecord(message.metadata)?.fromAgent);

export const deriveA2AExchange = (input: {
  source: BotView;
  peer: BotView;
  sourceChannel: ChannelView;
  sourceMessages: readonly ChannelMessageView[];
}): { channel: ChannelView; messages: ChannelMessageView[] } => {
  const id = `a2a:${input.source.id}:${input.peer.id}`;
  const messages = input.sourceMessages
    .filter((message) => peerIdFor(message) === input.peer.id)
    .map((message) => ({
      ...message,
      channelId: id,
      sender: "agent" as const,
      senderBotId: isIncoming(message) ? input.peer.id : input.source.id,
    }));
  const updatedAt = messages.at(-1)?.createdAt ?? input.sourceChannel.updatedAt;
  return {
    channel: {
      id,
      kind: "agent_dm",
      name: `${input.source.name} ↔ ${input.peer.name}`,
      directKey: `agents:${[input.source.id, input.peer.id].sort().join(":")}`,
      workingDirectory: null,
      members: [
        { botId: input.source.id, ordinal: 0 },
        { botId: input.peer.id, ordinal: 1 },
      ],
      createdAt: input.sourceChannel.createdAt,
      updatedAt,
    },
    messages,
  };
};
