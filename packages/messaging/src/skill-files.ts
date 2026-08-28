import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Prisma } from "@openbot/db";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { atomicWrite, listDirectories, readText, uniqueSlug } from "./file-state";

export const MAX_SKILL_NAME = 80;
export const MAX_SKILL_DESCRIPTION = 1_536;
export const MAX_SKILL_BODY = 100_000;
export const MAX_INJECTED_SKILL_BODY = 8_000;

export interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

const requiredText = (value: unknown, name: string, maximum: number): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${name} is longer than ${maximum} characters`);
  return text;
};

export const parseSkillFile = (text: string, label: string): ParsedSkillFile => {
  if (text.length > MAX_SKILL_BODY + 16_384) throw new Error(`${label} is too large`);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`${label} must start with YAML frontmatter`);
  const document = parseDocument(match[1] ?? "", { prettyErrors: true });
  if (document.errors.length > 0) throw new Error(`${label}: ${document.errors[0]?.message}`);
  const raw = document.toJS() as unknown;
  if (!raw || Array.isArray(raw) || typeof raw !== "object") {
    throw new Error(`${label} frontmatter must be a mapping`);
  }
  const frontmatter = raw as Record<string, unknown>;
  const name = requiredText(frontmatter.name, "skill name", MAX_SKILL_NAME);
  const description = requiredText(
    frontmatter.description,
    "skill description",
    MAX_SKILL_DESCRIPTION
  );
  const body = (match[2] ?? "").trim();
  if (body.length > MAX_SKILL_BODY)
    throw new Error(`skill body is longer than ${MAX_SKILL_BODY} characters`);
  return { name, description, body, frontmatter };
};

export const renderSkillFile = (skill: {
  name: string;
  description: string;
  body: string;
  frontmatter?: Prisma.JsonValue | Record<string, unknown>;
}): string => {
  const raw =
    skill.frontmatter && typeof skill.frontmatter === "object" && !Array.isArray(skill.frontmatter)
      ? { ...(skill.frontmatter as Record<string, unknown>) }
      : {};
  raw.name = skill.name;
  raw.description = skill.description;
  delete raw.id;
  const yaml = stringifyYaml(raw).trimEnd();
  return `---\n${yaml}\n---\n\n${skill.body.trim()}\n`;
};

export const writeSkillFile = async (
  botDirectory: string,
  input: {
    slug?: string;
    name: string;
    description: string;
    body: string;
    frontmatter?: Record<string, unknown>;
  }
): Promise<{ slug: string; path: string }> => {
  const skillsRoot = join(botDirectory, "skills");
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  const occupied = new Set(await listDirectories(skillsRoot));
  const slug = input.slug ?? uniqueSlug(input.name, "skill", occupied);
  if (input.slug && !occupied.has(input.slug))
    await mkdir(join(skillsRoot, slug), { recursive: true });
  const path = join(skillsRoot, slug, "SKILL.md");
  await atomicWrite(path, renderSkillFile(input));
  return { slug, path };
};

export const deleteSkillFolder = async (botDirectory: string, slug: string): Promise<void> => {
  await rm(join(botDirectory, "skills", slug), {
    recursive: true,
    force: true,
  });
};

export const readSkillCatalog = async (
  botDirectory: string
): Promise<Array<ParsedSkillFile & { slug: string; path: string }>> => {
  const skillsRoot = join(botDirectory, "skills");
  const result: Array<ParsedSkillFile & { slug: string; path: string }> = [];
  for (const slug of await listDirectories(skillsRoot)) {
    const path = join(skillsRoot, slug, "SKILL.md");
    const text = await readText(path, MAX_SKILL_BODY + 16_384);
    if (text === null) continue;
    result.push({
      slug,
      path,
      ...parseSkillFile(text, `skills/${slug}/SKILL.md`),
    });
  }
  return result;
};
