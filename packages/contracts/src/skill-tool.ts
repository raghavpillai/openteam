// The Skill tool and its catalog as the reference words them: load a skill by name, or search by query.

export const SKILL_TOOL_NAME = "Skill";

export const SKILL_TOOL_DESCRIPTION = [
  "Load one of your skills by name and get its instructions.",
  "Returns the SKILL.md body without its frontmatter. Unless the result says there is nothing more to read, it also names the skill's directory and any helper files your skill store lists beside it. Its instructions name the helper files they use; do not guess at other file names.",
  "Call this instead of reading a SKILL.md with Read, then follow the instructions. Relative paths in a skill resolve against its directory; open a helper file with Read.",
].join("\n");

export const SKILL_NAME_PARAMETER =
  "The skill to load: its name as your skill catalog gives it, or the name in its frontmatter. The catalog gives a skill by its path when another skill shares its name; pass that path. A name no skill has returns the closest matches instead.";
export const SKILL_QUERY_PARAMETER =
  "Words that describe the task or the skill you need, passed instead of name. Returns the skills that match best, to load by name; loads nothing.";

export const SKILL_NAME_OR_QUERY_REQUIRED = "Pass name to load a skill, or query to search your skills.";

export interface CatalogSkill {
  id?: string;
  /** The name in the skill's frontmatter. */
  name: string;
  description: string;
  filePath: string;
}

/** A skill's tool name is its folder's name. */
export const skillToolName = (skill: Pick<CatalogSkill, "filePath">): string => {
  const parts = skill.filePath.replace(/\\/g, "/").split("/");
  const last = parts.at(-1) ?? "";
  return last === "SKILL.md" && parts.length >= 2 ? parts.at(-2)! : last;
};

/** A skill is listed by its name, or by its path when another skill shares that name. */
const catalogLabels = (skills: readonly CatalogSkill[]): Map<string, string> => {
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skillToolName(skill), (counts.get(skillToolName(skill)) ?? 0) + 1);
  return new Map(skills.map((skill) => [skill.filePath, (counts.get(skillToolName(skill)) ?? 0) > 1 ? skill.filePath : skillToolName(skill)]));
};

export const skillCatalogLine = (label: string, description: string | undefined): string => {
  const line = description?.replace(/\s+/g, " ").trim();
  return line ? `- ${label}: ${line}` : `- ${label}`;
};

const unlistedSkillsNudge = (count: number) =>
  `${count === 1 ? "1 of your skills is not listed" : `${count} of your skills are not listed`}, to save space. When no listed skill fits the task, call ${SKILL_TOOL_NAME} with query to search all your skills.`;
const SHORTENED_DESCRIPTIONS_NUDGE = `Some descriptions above are shortened or left out, to save space. Call ${SKILL_TOOL_NAME} with query to search the full descriptions.`;

// The catalog may take 2% of the context window, counted at four characters a token.
const SKILL_CATALOG_CONTEXT_FRACTION = 0.02;
const FALLBACK_CONTEXT_TOKENS = 200_000;
const MIN_TRUNCATED_DESCRIPTION = 24;
const MAX_TRUNCATED_DESCRIPTION = 480;
const estimateTokens = (text: string) => Math.round(text.length / 4);
const truncate = (description: string | undefined, max: number) =>
  description === undefined || description.length <= max ? description : `${description.slice(0, Math.max(0, max - 3)).trimEnd()}...`;

/**
 * The skill catalog the agent_skills section holds when skills load with the Skill tool. Over budget,
 * descriptions are shortened, then left out, then skills drop off the end, each with the reference's nudge.
 */
export function renderSkillToolCatalog(skills: readonly CatalogSkill[], contextTokens = FALLBACK_CONTEXT_TOKENS): string | undefined {
  if (!skills.length) return undefined;
  const labels = catalogLabels(skills);
  const render = (items: ReadonlyArray<{ filePath: string; description?: string }>, notice?: string) =>
    [
      `When a skill below fits the task, load it with ${SKILL_TOOL_NAME} before acting on the task; do not just mention it.`,
      "",
      "Your skills, one per line as name: when to use it. A skill that shares its name with another is listed by its path.",
      ...items.map((item) => skillCatalogLine(labels.get(item.filePath) ?? item.filePath, item.description)),
      ...(notice ? ["", notice] : []),
    ].join("\n");
  const budget = Math.floor(contextTokens * SKILL_CATALOG_CONTEXT_FRACTION);
  const full = render(skills);
  if (estimateTokens(full) <= budget) return full;
  const longest = Math.max(...skills.map((skill) => skill.description.length));
  for (let max = Math.min(longest - 1, MAX_TRUNCATED_DESCRIPTION); max >= MIN_TRUNCATED_DESCRIPTION; max -= 8) {
    const shortened = render(skills.map((skill) => ({ ...skill, description: truncate(skill.description, max) })), SHORTENED_DESCRIPTIONS_NUDGE);
    if (estimateTokens(shortened) <= budget) return shortened;
  }
  const pathOnly = skills.map(({ filePath }) => ({ filePath }));
  const bare = render(pathOnly, SHORTENED_DESCRIPTIONS_NUDGE);
  if (estimateTokens(bare) <= budget) return bare;
  let kept = pathOnly.length - 1;
  while (kept > 0 && estimateTokens(render(pathOnly.slice(0, kept), unlistedSkillsNudge(pathOnly.length - kept))) > budget) kept -= 1;
  return render(pathOnly.slice(0, kept), unlistedSkillsNudge(pathOnly.length - kept));
}

const looseKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const comparablePath = (path: string) => {
  const normalized = path.trim().replace(/\/+/g, "/").replace(/\/+$/, "");
  return normalized.endsWith("/SKILL.md") ? normalized.slice(0, -"/SKILL.md".length) : normalized;
};
const distinct = <T extends CatalogSkill>(skills: T[]) => skills.filter((skill, index) => skills.findIndex((other) => other.filePath === skill.filePath) === index);

export type SkillResolution<T extends CatalogSkill> = { kind: "found"; skill: T } | { kind: "ambiguous"; candidates: T[] } | { kind: "missing" };

/** A path when the request has a slash; otherwise the folder name, the id, then a loose match on folder or frontmatter name. */
export function resolveSkill<T extends CatalogSkill>(skills: readonly T[], requested: string): SkillResolution<T> {
  const query = requested.trim();
  const key = looseKey(query);
  const tiers: Array<(skill: T) => boolean> = query.includes("/")
    ? [(skill) => comparablePath(skill.filePath) === comparablePath(query)]
    : [
        (skill) => skillToolName(skill) === query,
        (skill) => skill.id === query,
        (skill) => key.length > 0 && (looseKey(skillToolName(skill)) === key || looseKey(skill.name) === key),
      ];
  for (const matches of tiers) {
    const found = distinct(skills.filter(matches));
    if (found.length === 1) return { kind: "found", skill: found[0]! };
    if (found.length > 1) return { kind: "ambiguous", candidates: found };
  }
  return { kind: "missing" };
}

export const ambiguousSkillMessage = (requested: string, candidates: readonly CatalogSkill[]) =>
  `More than one skill matches "${requested}". Call ${SKILL_TOOL_NAME} again with the one you mean, by its catalog path: ${candidates.map((skill) => skill.filePath).join(", ")}.`;

const NON_DISCRIMINATING_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "can", "do", "for", "from", "help", "how", "i", "in", "into", "is", "it",
  "me", "my", "need", "of", "on", "or", "some", "that", "the", "this", "to", "use", "using", "want", "we", "what", "when", "which",
  "with", "you", "your", "skill", "skills",
]);
const words = (text: string) =>
  text.normalize("NFC").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_/.:]+/g, " ").toLowerCase().match(/[a-z0-9]+/g) ?? [];
const withinOneEdit = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};
const wordMatch = (word: string, token: string) =>
  token === word ? 1 : token.startsWith(word) && word.length >= 2 ? 0.7 : word.length >= 4 && withinOneEdit(word, token) ? 0.5 : word.length >= 3 && token.includes(word) ? 0.4 : 0;

/**
 * Skills ranked for a query, best first. Like the reference's ranker, each query word scores its best match in the
 * skill's name (weighted most), frontmatter name and description, and the total is scaled by the share of words matched.
 */
export function searchSkills<T extends CatalogSkill>(skills: readonly T[], query: string, limit = 10): T[] {
  const queryWords = [...new Set(words(query))].filter((word) => !NON_DISCRIMINATING_WORDS.has(word)).slice(0, 8);
  if (!queryWords.length) return [];
  const scored = skills.flatMap((skill, index) => {
    const fields: Array<[string[], number]> = [
      [words(skillToolName(skill)), 3.8],
      [skill.name === skillToolName(skill) ? [] : words(skill.name), 1.4],
      [words(skill.description), 1.4],
    ];
    let total = 0, matched = 0;
    for (const word of queryWords) {
      const best = Math.max(0, ...fields.flatMap(([tokens, weight]) => tokens.map((token) => wordMatch(word, token) * weight)));
      if (best > 0) { total += best; matched += 1; }
    }
    const score = total * (matched / queryWords.length);
    return score > 0 ? [{ skill, index, score }] : [];
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(({ skill }) => skill);
}

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** A search's answer: the closest skills to load, or what to do when none matches. */
export function renderSkillSearch(input: {
  query: string;
  results: readonly CatalogSkill[];
  labelOf: (skill: CatalogSkill) => string;
  hasSkills: boolean;
  missingName?: string;
}): string {
  const notFound = input.missingName === undefined ? undefined : `No skill named "${escapeXml(input.missingName)}"`;
  const lines = input.results.length
    ? [...(notFound ? [`${notFound}. Closest matches:`] : []), ...input.results.map((skill) => skillCatalogLine(input.labelOf(skill), skill.description)), `Call ${SKILL_TOOL_NAME} with one of these names to load it.`]
    : !input.hasSkills
      ? [notFound ? `${notFound}. You have no skills to load.` : "You have no skills to load."]
      : [notFound
          ? `${notFound}, and no skill is a close match. Call ${SKILL_TOOL_NAME} with query, in words that describe the task, or go on without a skill.`
          : "No skill matches this query. Search again with other words, or go on without a skill."];
  return [`<skill_search query="${escapeXml(input.query)}">`, ...lines, "</skill_search>"].join("\n");
}

/** How a search result names a skill: by name when that name loads it, otherwise by path. */
export const skillSearchLabel = (skills: readonly CatalogSkill[], skill: CatalogSkill): string => {
  const resolution = resolveSkill(skills, skillToolName(skill));
  return resolution.kind === "found" && resolution.skill.filePath === skill.filePath ? skillToolName(skill) : skill.filePath;
};

// A body this long may have been cut short when it was read.
export const SKILL_MAX_BODY_LENGTH = 100_000;

/** A loaded skill: its body, then whether there is more to read and where. */
export function renderSkillContent(input: { name: string; body: string; directory: string; files: readonly string[]; truncated: boolean }): string {
  const directoryLines = [
    "",
    `Skill directory: ${input.directory}`,
    "Relative paths in this skill are relative to the skill directory.",
    ...(input.files.length ? ["", "<skill_resources>", ...input.files.map((file) => `  <file>${escapeXml(file)}</file>`), "</skill_resources>"] : []),
  ];
  const note = input.truncated
    ? "(This SKILL.md was cut short. Read the rest of it from the skill directory before relying on it.)"
    : input.files.length === 0
      ? "(This is the whole SKILL.md minus its frontmatter, and the skill has no helper files. There is nothing more to read.)"
      : "(This is the whole SKILL.md minus its frontmatter. Reading the file would show nothing more.)";
  return [
    `<skill_content name="${escapeXml(input.name)}">`,
    input.body.trim(),
    "",
    note,
    ...(!input.truncated && input.files.length === 0 ? [] : directoryLines),
    "</skill_content>",
  ].join("\n");
}
