import { normalizeMemoryContent } from "./memory-facts";
import { relevanceTokens } from "./recall-memory";
import { resolveTimeZone } from "./timestamps";

// Compatibility target: the inspected Grok Bot ecc8113 file-memory lifecycle.
const TRIVIAL_EXCHANGES = new Set(
  "hi|hey|hello|yo|sup|thanks|thank you|ty|thx|ok|okay|k|kk|cool|nice|great|awesome|perfect|yes|yep|yeah|no|nope|sure|got it|gotcha|lol|haha|np|done|good|bye".split(
    "|"
  )
);

export interface ExtractedMemories {
  additions: Array<{ content: string; kind: "profile" | "log" }>;
  removals: string[];
}

const memoryKey = (content: string): string => normalizeMemoryContent(content).toLowerCase();

export const isMemorableExchange = (userMessage: string): boolean => {
  const user = userMessage.trim();
  if (!user) return false;
  if (user.length > 40 || user.includes("?")) return true;
  const normalized = user
    .toLowerCase()
    .replace(/[\s!.…,~)\]]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return !TRIVIAL_EXCHANGES.has(normalized);
};

export interface ExtractionFact {
  content: string;
  tier: string;
  createdAt: Date;
  importance: number;
}

/** Profile first, then recent salient history, then up to ten relevant older facts. Facts arrive oldest first. */
export const gatherExtractionMemories = (
  facts: readonly ExtractionFact[],
  exchange: string
): string[] => {
  const indexed = facts.map((fact, order) => ({ fact, order }));
  type IndexedFact = (typeof indexed)[number];
  const byRecency = (left: IndexedFact, right: IndexedFact): number =>
    right.fact.createdAt.getTime() - left.fact.createdAt.getTime() || right.order - left.order;
  const rank = ({ fact }: IndexedFact): number =>
    Math.log2(fact.importance) + fact.createdAt.getTime() / (30 * 86_400_000);
  const profile = indexed.filter(({ fact }) => fact.tier === "profile").sort(byRecency);
  const logs = indexed.filter(({ fact }) => fact.tier !== "profile").sort(byRecency);
  const recent = [...logs].sort(
    (left, right) => rank(right) - rank(left) || byRecency(left, right)
  );
  const inPrompt = [...profile.slice(0, 100), ...recent.slice(0, 30)];
  const seen = new Set(inPrompt.map(({ fact }) => memoryKey(fact.content)));
  const queryTokens = relevanceTokens(exchange);
  const relevant = [...profile, ...logs]
    .slice(0, 500)
    .filter(({ fact }) => !seen.has(memoryKey(fact.content)))
    .map(({ fact }) => ({
      fact,
      overlap: [...relevanceTokens(fact.content)].filter((token) => queryTokens.has(token)).length,
    }))
    .filter(({ overlap }) => overlap > 0)
    .sort(
      (left, right) =>
        right.overlap - left.overlap ||
        right.fact.createdAt.getTime() - left.fact.createdAt.getTime()
    )
    .slice(0, 10);
  return [...inPrompt, ...relevant].map(({ fact }) => fact.content);
};

export interface MemoryExchange {
  user: string;
  agent: string;
}

/** An exchange held until its extraction finishes; one left over was interrupted. */
export interface HeldMemoryExchange extends MemoryExchange {
  id: string;
}

const MAX_HELD_EXCHANGE_SIDE_CHARS = 8_000;
const HELD_EXCHANGE_OMISSION = "\n[...middle omitted...]\n";

const boundExchangeText = (value: string): string => {
  const text = value.trim();
  if (text.length <= MAX_HELD_EXCHANGE_SIDE_CHARS) return text;
  const half = Math.floor(MAX_HELD_EXCHANGE_SIDE_CHARS / 2);
  return `${text.slice(0, half)}${HELD_EXCHANGE_OMISSION}${text.slice(-half)}`;
};

export const holdMemoryExchange = (exchange: HeldMemoryExchange): HeldMemoryExchange => ({
  id: exchange.id,
  user: boundExchangeText(exchange.user),
  agent: boundExchangeText(exchange.agent),
});

export const parseHeldMemoryExchanges = (value: unknown): HeldMemoryExchange[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const held = entry as Partial<HeldMemoryExchange> | null;
        return held && typeof held.id === "string" && typeof held.user === "string" && typeof held.agent === "string"
          ? [{ id: held.id, user: held.user, agent: held.agent }]
          : [];
      })
    : [];

/** "Monday Oct 5, 2026 (Europe/Paris)": the turn's date in the user's configured zone. */
export const renderTurnMemoryDate = (at: Date, timeZone: string): string => {
  const zone = resolveTimeZone(timeZone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "short", day: "2-digit", year: "numeric" })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
  return `${parts.weekday} ${parts.month} ${Number.parseInt(parts.day ?? "", 10)}, ${parts.year} (${zone})`;
};

const exchangeLines = (user: string, agent: string) => [
  `User: ${user.trim() || "(no message)"}`,
  `Assistant: ${agent.trim() || "(no message)"}`,
];

export const buildExtractionUserPrompt = (
  user: string,
  assistant: string,
  existingMemories: readonly string[],
  earlierExchanges: readonly MemoryExchange[] = [],
  today?: string
): string =>
  [
    "Existing memory:",
    existingMemories.length
      ? existingMemories.map((memory) => `- ${memory}`).join("\n")
      : "(empty)",
    "",
    ...(today === undefined ? [] : [`Today's date: ${today}`, ""]),
    ...earlierExchanges.flatMap((exchange) => [
      "Earlier exchange (not yet reviewed):",
      ...exchangeLines(exchange.user, exchange.agent),
      "",
    ]),
    "Latest exchange:",
    ...exchangeLines(user, assistant),
  ].join("\n");

/** Preserve the reference line protocol, including its untagged-log fallback. */
export const parseExtractedMemories = (
  raw: string,
  existingMemories: readonly string[]
): ExtractedMemories => {
  const result: ExtractedMemories = { additions: [], removals: [] };
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toUpperCase() === "NONE") return result;
  const seen = new Set(existingMemories.map(memoryKey));
  for (const line of trimmed.split("\n")) {
    const stripped = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
    const category = /^(profile|log|note|remove)\s*:\s*(.+)$/i.exec(stripped);
    const tag = category?.[1]?.toLowerCase();
    const bare = normalizeMemoryContent(category ? (category[2] ?? "") : stripped);
    if (!bare || bare.toUpperCase() === "NONE") continue;
    if (tag === "remove") {
      result.removals.push(bare);
      continue;
    }
    const content = tag === "note" ? normalizeMemoryContent(`[note] ${bare}`) : bare;
    const key = memoryKey(content);
    if (seen.has(key)) continue;
    seen.add(key);
    result.additions.push({ content, kind: tag === "profile" ? "profile" : "log" });
  }
  return result;
};
