/** Owner-facing bot memory. Shared user/project shards have separate ownership. */
export interface BotMemoryEntry {
  id: string;
  content: string;
  createdAt: number;
  kind: "profile" | "log";
}

export interface BotMemoryList {
  botId: string;
  memories: BotMemoryEntry[];
  total: number;
  limit: number;
}

export const BOT_MEMORY_LIST_LIMIT = 1_000;
