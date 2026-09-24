import { parseDocument } from "yaml";

/** Preserve provider frontmatter and formatting while it still matches the projected skill. */
export function originalSkillMarkdown(
  skill: { name: string; description: string; body: string },
  original: string | undefined
): string | undefined {
  if (original === undefined) return undefined;
  const parsed = parseSkillMarkdown(original, skill.name);
  return parsed.name === skill.name &&
    parsed.description === skill.description &&
    parsed.body === skill.body
    ? original
    : undefined;
}

/** Parse SKILL.md consistently for package import and private skill editors. */
export function parseSkillMarkdown(text: string, fallbackName = "skill") {
  if (text.length > 116_384) throw new Error("Skill file is too large");
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!front) return { name: fallbackName, description: "", body: text };
  const document = parseDocument(front[1]!, { prettyErrors: false });
  if (document.errors.length)
    throw new Error(`Invalid skill frontmatter: ${document.errors[0]!.message}`);
  const metadata = document.toJS({ maxAliasCount: 50 }) as unknown;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Skill frontmatter must be a mapping");
  const fields = metadata as Record<string, unknown>;
  for (const key of ["name", "description"])
    if (fields[key] !== undefined && typeof fields[key] !== "string")
      throw new Error(`Skill ${key} must be text`);
  return {
    name: (fields.name as string | undefined)?.trim() || fallbackName,
    description: (fields.description as string | undefined)?.trim() ?? "",
    body: text.slice(front[0].length),
  };
}
