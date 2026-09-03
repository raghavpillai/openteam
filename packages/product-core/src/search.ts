import type { SearchCategory, SearchResultKind } from "@openteam/contracts";

export const SEARCH_CACHE_LIMIT = 64;
export const SEARCH_QUERY_MAX_LENGTH = 200;

export const SEARCH_CATEGORIES: ReadonlyArray<{
  category: SearchCategory;
  label: string;
}> = [
  { category: "all", label: "All" },
  { category: "messages", label: "Messages" },
  { category: "bots", label: "Bots" },
  { category: "channels", label: "Chats" },
  { category: "files", label: "Files" },
  { category: "links", label: "Links" },
  { category: "routines", label: "Routines" },
];

export const searchResultKindLabel = (kind: SearchResultKind): string => {
  switch (kind) {
    case "bot":
      return "Bot";
    case "channel":
      return "Chat";
    case "message":
      return "Message";
    case "file":
      return "File";
    case "link":
      return "Link";
    case "routine":
      return "Routine";
  }
};

export const searchCategoryKind = (category: SearchCategory): SearchResultKind | null => {
  switch (category) {
    case "messages":
      return "message";
    case "bots":
      return "bot";
    case "channels":
      return "channel";
    case "files":
      return "file";
    case "links":
      return "link";
    case "routines":
      return "routine";
    default:
      return null;
  }
};

export interface NormalizeSearchQueryOptions {
  lowercase?: boolean;
  maxLength?: number;
}

export const normalizeSearchQuery = (
  value: string,
  { lowercase = false, maxLength = SEARCH_QUERY_MAX_LENGTH }: NormalizeSearchQueryOptions = {}
): string => {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  const cased = lowercase ? normalized.toLocaleLowerCase() : normalized;
  return cased.slice(0, Math.max(0, Math.trunc(maxLength)));
};

export const searchTextMatches = (query: string, ...values: string[]): boolean => {
  const normalized = normalizeSearchQuery(query, { lowercase: true });
  if (!normalized) return true;
  const haystack = normalizeSearchQuery(values.join(" "), { lowercase: true });
  return normalized.split(" ").every((term) => haystack.includes(term));
};

export interface SearchRequestToken {
  cacheKey: string;
  generation: number;
}

export interface SearchRequestGate {
  begin: (cacheKey: string) => SearchRequestToken;
  invalidate: () => void;
  isCurrent: (token: SearchRequestToken) => boolean;
}

/** Reject stale responses even when an aborted transport still resolves. */
export const createSearchRequestGate = (): SearchRequestGate => {
  let generation = 0;
  let current: SearchRequestToken | null = null;

  return {
    begin: (cacheKey) => {
      const token = { cacheKey, generation: ++generation };
      current = token;
      return token;
    },
    invalidate: () => {
      generation += 1;
      current = null;
    },
    isCurrent: (token) =>
      current?.generation === token.generation && current.cacheKey === token.cacheKey,
  };
};

/** Include the server snapshot cursor so mobile results cannot cross revisions. */
export const searchCacheKey = (cursor: string, category: string, normalizedQuery: string): string =>
  JSON.stringify([cursor, category, normalizedQuery.toLocaleLowerCase()]);

/** Read and promote an LRU entry. */
export const readSearchCache = <Value>(
  cache: Map<string, Value>,
  key: string
): Value | undefined => {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
};

/** Write an LRU entry while enforcing a positive, bounded entry count. */
export const writeSearchCache = <Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value,
  limit = SEARCH_CACHE_LIMIT
): void => {
  cache.delete(key);
  cache.set(key, value);
  const boundedLimit = Math.max(1, Math.trunc(limit));
  while (cache.size > boundedLimit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};
