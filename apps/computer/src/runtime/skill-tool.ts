import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ambiguousSkillMessage,
  type CatalogSkill,
  renderSkillContent,
  renderSkillSearch,
  resolveSkill,
  searchSkills,
  SKILL_MAX_BODY_LENGTH,
  SKILL_NAME_OR_QUERY_REQUIRED,
  SKILL_NAME_PARAMETER,
  SKILL_QUERY_PARAMETER,
  SKILL_TOOL_DESCRIPTION,
  SKILL_TOOL_NAME,
  skillSearchLabel,
  skillToolName,
} from "@openteam/contracts/skill-tool";

export { SKILL_TOOL_NAME };

export interface AgentSkill extends CatalogSkill {
  id?: string;
}

const agentDataRoot = () => process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/home/box/agent-data";

/** Managed skills whose catalog record names this agent. */
export const agentSkills = (agent: string, root = agentDataRoot()): AgentSkill[] => {
  let cache: { skills?: unknown };
  try {
    cache = JSON.parse(readFileSync(join(root, "managed-skills", "cache.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(cache.skills)) return [];
  return cache.skills.flatMap((record) => {
    const skill = record as Record<string, unknown>;
    return Array.isArray(skill.agents) &&
      skill.agents.includes(agent) &&
      typeof skill.name === "string" &&
      typeof skill.description === "string" &&
      typeof skill.filePath === "string"
      ? [{ ...(typeof skill.id === "string" ? { id: skill.id } : {}), name: skill.name, description: skill.description, filePath: skill.filePath }]
      : [];
  });
};

const stripFrontmatter = (content: string) =>
  content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/^\s+/, "");

const helperFiles = async (directory: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (relative(directory, path) !== "SKILL.md") found.push(relative(directory, path));
    }
  };
  await walk(directory);
  return found.sort();
};

const loadSkillContent = async (skill: AgentSkill): Promise<string> => {
  const name = skillToolName(skill);
  const content = await readFile(skill.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new Error(
      error.code === "ENOENT"
        ? `The skill "${name}" is in your catalog but its SKILL.md is missing at ${skill.filePath}. The catalog may be out of date.`
        : `Could not read the SKILL.md of "${name}" at ${skill.filePath}: ${error.message}.`
    );
  });
  const body = stripFrontmatter(content);
  const directory = dirname(skill.filePath);
  return renderSkillContent({ name, body, directory, files: await helperFiles(directory), truncated: body.length >= SKILL_MAX_BODY_LENGTH });
};

/** Load the named skill, or search by query; a name no skill has returns the closest matches. */
export const loadOrSearchSkill = async (skills: readonly AgentSkill[], args: { name?: unknown; query?: unknown }): Promise<string> => {
  const present = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const name = present(args.name), query = present(args.query);
  const search = (text: string, missingName?: string) =>
    renderSkillSearch({
      query: text,
      results: searchSkills(skills, text),
      labelOf: (skill) => skillSearchLabel(skills, skill),
      hasSkills: skills.length > 0,
      ...(missingName === undefined ? {} : { missingName }),
    });
  if (name === undefined) {
    if (query === undefined) throw new Error(SKILL_NAME_OR_QUERY_REQUIRED);
    return search(query);
  }
  const resolution = resolveSkill(skills, name);
  if (resolution.kind === "missing") return search(query ?? name, name);
  if (resolution.kind === "ambiguous") throw new Error(ambiguousSkillMessage(name, resolution.candidates));
  return loadSkillContent(resolution.skill);
};

/** The Skill tool for a worker that carries skills of its own; its catalog is in the worker's agent_skills section. */
export const skillTool = (agent: string) => {
  const skills = agentSkills(agent);
  return defineTool({
    name: SKILL_TOOL_NAME,
    label: SKILL_TOOL_NAME,
    description: SKILL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: SKILL_NAME_PARAMETER })),
      query: Type.Optional(Type.String({ description: SKILL_QUERY_PARAMETER })),
    }),
    executionMode: "parallel",
    execute: async (_callId, args): Promise<AgentToolResult<Record<string, unknown>>> => ({
      content: [{ type: "text", text: await loadOrSearchSkill(skills, args as { name?: unknown; query?: unknown }) }],
      details: {},
    }),
  });
};
