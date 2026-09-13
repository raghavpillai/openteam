import { expect, test } from "bun:test";
import { parseSkillMarkdown } from "../src/skill-markdown";
import { importPackage } from "../src/package";

test("private and packaged skill imports share YAML quoting and multiline semantics", () => {
  const text =
    '---\r\nname: "Review: package"\r\ndescription: >-\r\n  Use for package\r\n  verification.\r\n---\r\nCheck references/check.md.\r\n';
  const parsed = parseSkillMarkdown(text);
  expect(parsed).toEqual({
    name: "Review: package",
    description: "Use for package verification.",
    body: "Check references/check.md.\r\n",
  });
  const imported = importPackage({
    ".cursor-plugin/plugin.json": JSON.stringify({
      name: "review",
      version: "1.0.0",
      description: "Review",
      skills: "./skills",
    }),
    "skills/review/SKILL.md": text,
  });
  expect(imported.definition.skills[0]).toMatchObject(parsed);
  expect(parseSkillMarkdown("Plain instructions", "plain-skill")).toEqual({
    name: "plain-skill",
    description: "",
    body: "Plain instructions",
  });
});

test("malformed skill metadata fails before saving", () => {
  expect(() => parseSkillMarkdown("---\nname: [unterminated\n---\nbody")).toThrow("frontmatter");
  expect(() => parseSkillMarkdown("---\nname: 12\n---\nbody")).toThrow("must be text");
  expect(() => parseSkillMarkdown("---\n- list\n---\nbody")).toThrow("mapping");
});
