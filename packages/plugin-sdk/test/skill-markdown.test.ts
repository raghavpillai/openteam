import { expect, test } from "bun:test";
import { parseSkillMarkdown } from "../src/skill-markdown";

test("malformed skill metadata fails before saving", () => {
  expect(() => parseSkillMarkdown("---\nname: [unterminated\n---\nbody")).toThrow("frontmatter");
  expect(() => parseSkillMarkdown("---\nname: 12\n---\nbody")).toThrow("must be text");
  expect(() => parseSkillMarkdown("---\n- list\n---\nbody")).toThrow("mapping");
});
