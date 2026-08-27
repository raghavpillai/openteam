import type { SearchCategory } from "@openbot/contracts";

export type SearchSection = SearchCategory | "actions";

export const SEARCH_SECTIONS: ReadonlyArray<{ id: SearchSection; label: string }> = [
  { id: "all", label: "All" },
  { id: "messages", label: "Messages" },
  { id: "bots", label: "Bots" },
  { id: "channels", label: "Channels" },
  { id: "files", label: "Files" },
  { id: "links", label: "Links" },
  { id: "routines", label: "Routines" },
  { id: "actions", label: "Actions" },
];

export const moveSearchSection = (current: SearchSection, direction: -1 | 1): SearchSection => {
  const index = SEARCH_SECTIONS.findIndex((section) => section.id === current);
  return (
    SEARCH_SECTIONS[(index + direction + SEARCH_SECTIONS.length) % SEARCH_SECTIONS.length]?.id ??
    "all"
  );
};

export const moveSearchSelection = (current: number, count: number, direction: -1 | 1) => {
  if (count === 0) return -1;
  if (current < 0) return direction > 0 ? 0 : count - 1;
  return (current + direction + count) % count;
};

export const normalizeClientSearch = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

export const searchTextMatches = (query: string, ...values: string[]) => {
  const normalized = normalizeClientSearch(query);
  if (!normalized) return true;
  const haystack = normalizeClientSearch(values.join(" "));
  return normalized.split(" ").every((term) => haystack.includes(term));
};

export const searchTimeLabel = (value: string) => {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
};
