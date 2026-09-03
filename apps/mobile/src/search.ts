import type {
  AssetRef,
  ClientSnapshot,
  SearchCategory,
  SearchResponse,
  SearchResultView,
} from "@openteam/contracts";
import { normalizeSearchQuery, searchCategoryKind } from "@openteam/product-core/search";

const RESULT_LIMIT = 24;

export const normalizeMobileSearchQuery = normalizeSearchQuery;

const cleanCopy = (value: string, limit: number) =>
  value.replace(/\s+/g, " ").trim().slice(0, limit);

const metadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const attachmentList = (value: unknown): AssetRef[] =>
  Array.isArray(value)
    ? value.filter((item): item is AssetRef =>
        Boolean(
          item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof (item as Record<string, unknown>).assetId === "string" &&
            typeof (item as Record<string, unknown>).fileName === "string"
        )
      )
    : [];

const linksIn = (value: string) => {
  const matches = value.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, "")))];
};

const searchTerms = (query: string) =>
  (query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 8);

const matchesTerms = (result: SearchResultView, terms: readonly string[]) => {
  if (terms.length === 0) return false;
  const haystack = `${result.title} ${result.subtitle}`.normalize("NFKC").toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
};

const resultScore = (result: SearchResultView, query: string) => {
  if (!query) return 0;
  const title = result.title.normalize("NFKC").toLocaleLowerCase();
  const normalized = query.toLocaleLowerCase();
  if (title === normalized) return 4;
  if (title.startsWith(normalized)) return 1.5;
  return title.includes(normalized) ? 0.5 : 0;
};

/**
 * Keeps the fixture build searchable without pretending to reproduce PostgreSQL ranking.
 * Live mobile clients use the server's SearchDocument index through client.search().
 */
export const searchClientSnapshot = (
  snapshot: ClientSnapshot,
  queryValue: string,
  category: SearchCategory = "all"
): SearchResponse => {
  const query = normalizeMobileSearchQuery(queryValue);
  const kind = searchCategoryKind(category);
  const channelById = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
  const botById = new Map(snapshot.bots.map((bot) => [bot.id, bot]));
  const results: SearchResultView[] = [];

  for (const bot of snapshot.bots) {
    results.push({
      id: `fixture-bot-${bot.id}`,
      kind: "bot",
      title: bot.name,
      subtitle: cleanCopy(bot.description || bot.title || "Bot", 180),
      channelId: bot.dmChannelId,
      messageId: null,
      botId: bot.id,
      url: null,
      createdAt: bot.createdAt,
    });
  }

  for (const channel of snapshot.channels) {
    results.push({
      id: `fixture-channel-${channel.id}`,
      kind: "channel",
      title: channel.name,
      subtitle: cleanCopy(
        channel.description || (channel.kind === "group" ? "Group" : "Chat"),
        180
      ),
      channelId: channel.id,
      messageId: null,
      botId: channel.kind === "bot_dm" ? (channel.members[0]?.botId ?? null) : null,
      url: null,
      createdAt: channel.createdAt,
    });
  }

  for (const message of snapshot.channelMessages) {
    const channel = channelById.get(message.channelId);
    if (!channel) continue;
    const sender = message.senderBotId ? botById.get(message.senderBotId)?.name : "You";
    results.push({
      id: `fixture-message-${message.id}`,
      kind: "message",
      title: cleanCopy(message.content || "Attachment", 280),
      subtitle: `${sender ?? "Bot"} · ${channel.name}`,
      channelId: message.channelId,
      messageId: message.id,
      botId: message.senderBotId,
      url: null,
      createdAt: message.createdAt,
    });

    const metadata = metadataRecord(message.metadata);
    for (const [index, attachment] of attachmentList(metadata.attachments).entries()) {
      results.push({
        id: `fixture-file-${message.id}-${index}`,
        kind: "file",
        title: attachment.fileName,
        subtitle: `${channel.name} · ${attachment.mimeType ?? attachment.kind}`,
        channelId: message.channelId,
        messageId: message.id,
        botId: message.senderBotId,
        url: null,
        createdAt: message.createdAt,
      });
    }

    for (const [index, url] of linksIn(message.content).entries()) {
      results.push({
        id: `fixture-link-${message.id}-${index}`,
        kind: "link",
        title: url,
        subtitle: channel.name,
        channelId: message.channelId,
        messageId: message.id,
        botId: message.senderBotId,
        url,
        createdAt: message.createdAt,
      });
    }
  }

  if (category === "messages" && !query) return { query, results: [] };
  const terms = searchTerms(query);
  return {
    query,
    results: results
      .filter((result) => !kind || result.kind === kind)
      .filter((result) => {
        if (query) return matchesTerms(result, terms);
        if (category !== "all") return true;
        return result.kind === "bot" || (result.kind === "channel" && result.botId === null);
      })
      .sort(
        (left, right) =>
          resultScore(right, query) - resultScore(left, query) ||
          right.createdAt.localeCompare(left.createdAt) ||
          left.id.localeCompare(right.id)
      )
      .slice(0, RESULT_LIMIT),
  };
};
