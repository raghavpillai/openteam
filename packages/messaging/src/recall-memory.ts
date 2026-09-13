export interface RecallCandidate {
  content: string;
  createdAt: Date;
  tier: string;
  scope: "agent" | "user";
  via?: string;
}

const STOPWORDS = new Set("that this with from they them then than what when where which will would could should have been being about just like your does were also into over only some more most very much here there their these those because while after before user".split(" "));
export const relevanceTokens = (text: string) => new Set([...text.toLowerCase().matchAll(/[\p{L}\p{N}]{4,}/gu)].map(([token]) => token!).filter((token) => !STOPWORDS.has(token)));

export function parseRecallInput(input: unknown) {
  const args = input as Record<string, unknown> | null;
  if (!args || typeof args.query !== "string" || !args.query.trim()) throw new Error("RecallMemory query must be nonempty");
  return {
    query: args.query.trim(),
    scope: ["agent", "user", "all"].includes(String(args.scope)) ? args.scope as "agent" | "user" | "all" : "all" as const,
    limit: typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 50 ? args.limit : 20,
  };
}

export function recallMemoryResult(input: unknown, candidates: readonly RecallCandidate[]) {
  const { query, scope, limit } = parseRecallInput(input);
  const scoped = candidates.filter((fact) => scope === "all" || fact.scope === scope);
  const queryTokens = relevanceTokens(query);
  const overlaps = scoped.map((fact) => ({ fact, score: [...relevanceTokens(fact.content)].filter((token) => queryTokens.has(token)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.fact.createdAt.getTime() - a.fact.createdAt.getTime());
  const matches = (overlaps.length
    ? overlaps.map(({ fact }) => fact)
    : scoped.filter((fact) => fact.content.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  ).slice(0, limit);
  const label = scope === "agent" ? "your memory" : scope === "user" ? "the shared user memory" : "your memory and the shared user memory";
  if (!matches.length) return `No facts in ${label} match "${query}" (${scoped.length} searched). Try different words, or a shorter literal fragment.`;
  const lines = [`Top ${matches.length} ${matches.length === 1 ? "match" : "matches"} for "${query}" in ${label} (${scoped.length} ${scoped.length === 1 ? "fact" : "facts"} searched):`];
  let budget = 4_000;
  let shown = 0;
  for (const fact of matches) {
    const provenance = fact.scope === "user" ? `, shared${fact.via ? ` via ${fact.via}` : ""}` : "";
    const line = `- (${fact.createdAt.toISOString().slice(0, 10)}) [${fact.tier === "profile" ? "profile" : "log"}${provenance}] ${fact.content}`;
    if (shown > 0 && line.length > budget) break;
    lines.push(line); budget -= line.length; shown += 1;
  }
  if (shown < matches.length) lines.push(`(${matches.length - shown} more matches not shown — narrow the query.)`);
  return lines.join("\n");
}
