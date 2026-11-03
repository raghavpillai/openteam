export interface RecallCandidate {
  content: string;
  createdAt: Date;
  tier: string;
  scope: "agent" | "user";
  via?: string;
}

const STOPWORDS = new Set(
  "that this with from they them then than what when where which will would could should have been being about just like your does were also into over only some more most very much here there their these those because while after before user".split(
    " "
  )
);
export const relevanceTokens = (text: string) =>
  new Set(
    [...text.toLowerCase().matchAll(/[\p{L}\p{N}]{4,}/gu)]
      .map(([token]) => token!)
      .filter((token) => !STOPWORDS.has(token))
  );

const RECALL_MEMORY_DEFAULT_LIMIT = 20;
const RECALL_MEMORY_MAX_LIMIT = 50;
const RECALL_MEMORY_CHAR_BUDGET = 4_000;
const SEARCHED_LABEL = "your memory and the shared user memory";

export function parseRecallInput(input: unknown) {
  const args = input as Record<string, unknown> | null;
  if (!args || typeof args.query !== "string" || !args.query.trim())
    throw new Error("RecallMemory query must be nonempty");
  return {
    query: args.query.trim(),
    limit:
      typeof args.limit === "number" &&
      Number.isInteger(args.limit) &&
      args.limit >= 1 &&
      args.limit <= RECALL_MEMORY_MAX_LIMIT
        ? args.limit
        : RECALL_MEMORY_DEFAULT_LIMIT,
  };
}

/** The memory type a fact belongs to, and which assistant learned a shared one. */
const candidateLabel = (fact: RecallCandidate) => {
  const profile = fact.tier === "profile";
  if (fact.scope === "agent") return profile ? "profile" : "journal";
  const via = fact.via?.trim() ?? "";
  return `${profile ? "shared_profile" : "shared_journal"}${via ? ` via ${via}` : ""}`;
};

const formatDate = (date: Date) =>
  Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toISOString().slice(0, 10) : "unknown date";

/** Rank by distinct shared words, then newest; fall back to a literal match when nothing overlaps. */
export function recallMemoryResult(input: unknown, candidates: readonly RecallCandidate[]) {
  const { query, limit } = parseRecallInput(input);
  const queryTokens = relevanceTokens(query);
  const overlaps = candidates
    .map((fact) => ({
      fact,
      score: [...relevanceTokens(fact.content)].filter((token) => queryTokens.has(token)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.fact.createdAt.getTime() - a.fact.createdAt.getTime());
  const matches = (
    overlaps.length
      ? overlaps.map(({ fact }) => fact)
      : candidates
          .filter((fact) => fact.content.toLowerCase().includes(query.toLowerCase()))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  ).slice(0, limit);
  if (!matches.length)
    return `No facts in ${SEARCHED_LABEL} match "${query}" (${candidates.length} searched). Try different words, or a shorter literal fragment.`;
  const lines = [
    `Top ${matches.length} ${matches.length === 1 ? "match" : "matches"} for "${query}" in ${SEARCHED_LABEL} (${candidates.length} ${candidates.length === 1 ? "fact" : "facts"} searched):`,
  ];
  let budget = RECALL_MEMORY_CHAR_BUDGET;
  let shown = 0;
  for (const fact of matches) {
    const line = `- (${formatDate(fact.createdAt)}) [${candidateLabel(fact)}] ${fact.content}`;
    if (shown > 0 && line.length > budget) break;
    lines.push(line);
    budget -= line.length;
    shown += 1;
  }
  if (shown < matches.length)
    lines.push(`(${matches.length - shown} more matches not shown. Narrow the query.)`);
  return lines.join("\n");
}
