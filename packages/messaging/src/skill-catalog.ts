/** The reference's agent_skills catalog: a read-first preamble, then one item per skill with its absolute path. */

export const agentSkillItem = (fullPath: string, description: string): string =>
  `<agent_skill fullPath="${fullPath}">${description}</agent_skill>`;

const OMITTED_SKILLS = "Additional skills omitted from this initial list";

export const omittedSkillsNotice = (count: number, directories: readonly string[]): string =>
  `${OMITTED_SKILLS} (${count}). Directories containing omitted skills: ${directories.join(", ")}.`;

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
