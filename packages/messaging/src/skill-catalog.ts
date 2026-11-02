/** The reference's read-mode agent_skills catalog: a read-first preamble, then one item per skill with its absolute path. */

import { dirname } from "node:path";

export interface CatalogItem {
  fullPath: string;
  description?: string;
}

// The reference's prompt renderer trims text and collapses runs of spaces; an item with no text closes itself.
export const agentSkillItem = (fullPath: string, description?: string): string => {
  const text = description?.trim().replace(/ {2,}/g, " ");
  const path = fullPath.replaceAll('"', "&quot;");
  return text ? `<agent_skill fullPath="${path}">${text}</agent_skill>` : `<agent_skill fullPath="${path}" />`;
};

const OMITTED_SKILLS = "Additional skills omitted from this initial list";

export const omittedSkillsNotice = (count: number, directories: readonly string[]): string =>
  `${OMITTED_SKILLS} (${count}). Directories containing omitted skills: ${directories.join(", ")}.`;

/** The notice's directory hints: the folders of the first omitted skills, at most five. */
export const omittedSkillDirectories = (fullPaths: readonly string[]): string[] => [...new Set(fullPaths.map((path) => dirname(path)))].slice(0, 5);

/** Items are agentSkillItem entries joined by blank lines, optionally ending with an omittedSkillsNotice. */
export function renderAgentSkillsSection(items: string): string {
  const omitted = items.includes(OMITTED_SKILLS);
  const scope = !items.includes("<agent_skill ") && omitted
    ? "No skills are listed below, but additional skills may exist in the directories shown in the skills section if a later task specifically requires discovering more skills."
    : omitted
      ? "Use the skills listed below. If a later task specifically requires discovering more skills, additional skills may exist in the directories shown in the skills section."
      : "Only use skills listed below.";
  return [
    "<agent_skills>",
    `When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge. To use a skill, read the skill file at the provided absolute path using the Read tool, then follow the instructions within. When a skill is relevant, read and follow it IMMEDIATELY as your first action. NEVER just announce or mention a skill without actually reading and following it. ${scope}`,
    "",
    "",
    '<available_skills description="Skills the agent can use. Use the Read tool with the provided absolute path to fetch full contents.">',
    items,
    "</available_skills>",
    "</agent_skills>",
  ].join("\n");
}

// The reference's catalog budget: 2% of the context window, counted at four characters a token.
const CATALOG_CONTEXT_FRACTION = 0.02;
const FALLBACK_CONTEXT_TOKENS = 200_000;
const MIN_TRUNCATED_DESCRIPTION = 24;
const MAX_TRUNCATED_DESCRIPTION = 480;
const SHORT_DESCRIPTION_PATH_ONLY_THRESHOLD = 80;
// Skills whose descriptions the reference never drops or omits.
const PROTECTED_SKILLS = new Set([
  "canvas", "env-setup", "meetings", "purchases", "visualize", "x-api-mcp-guide", "accommodation-booking", "flight-booking", "food-ordering",
  "grocery-shopping", "job-search", "orders-and-returns", "restaurant-booking", "restaurant-recommendations", "rideshare", "scheduling", "shopping",
]);
const estimateTokens = (text: string) => Math.round(text.length / 4);
const skillFolder = (fullPath: string) => {
  const parts = fullPath.replace(/\\/g, "/").split("/");
  return parts.at(-1) === "SKILL.md" && parts.length >= 2 ? parts.at(-2)! : parts.at(-1) ?? "";
};
const truncate = (description: string | undefined, max: number) =>
  description === undefined || description.length <= max ? description : `${description.slice(0, Math.max(0, max - 3)).trimEnd()}...`;

/**
 * The whole agent_skills section for a list of skills. Over budget it shortens descriptions, then drops them, then omits
 * skills from the end with the reference's notice; protected skills keep their descriptions and are never omitted.
 */
export function renderSkillCatalog(skills: readonly CatalogItem[], contextTokens = FALLBACK_CONTEXT_TOKENS): string {
  if (!skills.length) return "";
  const render = (items: readonly CatalogItem[], notice?: string) =>
    renderAgentSkillsSection([...items.map((item) => agentSkillItem(item.fullPath, item.description)), ...(notice ? [notice] : [])].join("\n\n"));
  const isProtected = (skill: CatalogItem) => PROTECTED_SKILLS.has(skillFolder(skill.fullPath));
  const budget = Math.floor(contextTokens * CATALOG_CONTEXT_FRACTION);
  const droppable = skills.flatMap((skill, index) => (isProtected(skill) ? [] : [index]));
  const pathOnly = skills.map((skill) => (isProtected(skill) ? skill : { fullPath: skill.fullPath }));
  const omitting = () => {
    const retaining = (kept: number) => {
      const firstOmitted = kept < droppable.length ? droppable[kept]! : skills.length;
      const retained = pathOnly.filter((skill, index) => index < firstOmitted || isProtected(skill));
      const omitted = skills.filter((skill, index) => index >= firstOmitted && !isProtected(skill));
      const text = render(retained, omitted.length ? omittedSkillsNotice(omitted.length, omittedSkillDirectories(omitted.map((skill) => skill.fullPath))) : undefined);
      return { text, fits: estimateTokens(text) <= budget };
    };
    const upper = Math.min(droppable.length, budget);
    let fitting = retaining(0).text, fittingCount = 0, overflowing = upper + 1;
    for (let probe = 1; probe <= upper; probe *= 2) {
      const candidate = retaining(probe);
      if (!candidate.fits) { overflowing = probe; break; }
      fitting = candidate.text; fittingCount = probe;
    }
    while (overflowing - fittingCount > 1) {
      const midpoint = Math.floor((fittingCount + overflowing) / 2);
      const candidate = retaining(midpoint);
      if (candidate.fits) { fitting = candidate.text; fittingCount = midpoint; } else overflowing = midpoint;
    }
    return fitting;
  };
  if (droppable.length > budget) return omitting();
  const full = render(skills);
  if (estimateTokens(full) <= budget) return full;
  const longest = Math.max(0, ...skills.filter((skill) => !isProtected(skill)).map((skill) => skill.description?.length ?? 0));
  if (longest > SHORT_DESCRIPTION_PATH_ONLY_THRESHOLD) {
    let best: string | undefined;
    for (let low = MIN_TRUNCATED_DESCRIPTION, high = Math.min(longest - 1, MAX_TRUNCATED_DESCRIPTION); low <= high;) {
      const midpoint = Math.floor((low + high) / 2);
      const text = render(skills.map((skill) => (isProtected(skill) ? skill : { fullPath: skill.fullPath, description: truncate(skill.description, midpoint) })));
      if (estimateTokens(text) <= budget) { best = text; low = midpoint + 1; } else high = midpoint - 1;
    }
    if (best !== undefined) return best;
  }
  const bare = render(pathOnly);
  return estimateTokens(bare) <= budget ? bare : omitting();
}
