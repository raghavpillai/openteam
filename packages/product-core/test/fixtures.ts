import type { ChannelMessageView } from "@openteam/contracts";

export const view = (overrides: Partial<ChannelMessageView> = {}): ChannelMessageView => ({
  id: "message-1", sequence: "1", channelId: "chat", sender: "user", senderBotId: null, sourceRunId: null,
  content: "hello", metadata: {}, createdAt: "2026-09-01T00:00:00.000Z", ...overrides,
});
export const numbered = (n: number, overrides: Partial<ChannelMessageView> = {}) =>
  view({ id: `message-${n}`, sequence: String(n), sender: "agent", senderBotId: "bot", content: `Message ${n}`,
    createdAt: new Date(1_700_000_000_000 + n * 1000).toISOString(), ...overrides });
export const range = (start: number, count: number) => Array.from({ length: count }, (_, index) => numbered(start + index));
