import { expect, test } from "bun:test";
import { renderSkillToolCatalog, resolveSkill, searchSkills, skillToolName } from "../src/skill-tool";

const skill = (folder: string, description: string, name = folder) => ({ name, description, filePath: `/home/box/agent-data/managed-skills/${folder}/SKILL.md` });

test("the catalog lists skills by folder name, and by path when two share a name", () => {
  const catalog = renderSkillToolCatalog([skill("office-pptx", "Use for any\n  .pptx file."), { ...skill("office-pptx", "Other."), filePath: "/x/office-pptx/SKILL.md" }, skill("deck", "Decks.", "slides")]);
  expect(catalog).toBe(
    [
      "When a skill below fits the task, load it with Skill before acting on the task; do not just mention it.",
      "",
      "Your skills, one per line as name: when to use it. A skill that shares its name with another is listed by its path.",
      "- /home/box/agent-data/managed-skills/office-pptx/SKILL.md: Use for any .pptx file.",
      "- /x/office-pptx/SKILL.md: Other.",
      "- deck: Decks.",
    ].join("\n")
  );
  expect(renderSkillToolCatalog([])).toBeUndefined();
  expect(skillToolName(skill("deck", "x"))).toBe("deck");
});

test("over its budget the catalog shortens descriptions, then drops them, then skills, and says so", () => {
  const long = Array.from({ length: 6 }, (_, index) => skill(`skill-${index}`, "word ".repeat(200)));
  const shortened = renderSkillToolCatalog(long, 50_000)!;
  expect(shortened).toContain("...");
  expect(shortened).toEndWith("\n\nSome descriptions above are shortened or left out, to save space. Call Skill with query to search the full descriptions.");
  expect(Math.round(shortened.length / 4)).toBeLessThanOrEqual(1_000);
  const bare = renderSkillToolCatalog(long, 6_000)!;
  expect(bare).toContain("\n- skill-0\n- skill-1\n");
  const many = Array.from({ length: 60 }, (_, index) => skill(`skill-${index}`, "x"));
  const omitted = renderSkillToolCatalog(many, 10_000)!;
  expect(omitted).toMatch(/\n\n\d+ of your skills are not listed, to save space\. When no listed skill fits the task, call Skill with query to search all your skills\.$/);
  expect(Math.round(omitted.length / 4)).toBeLessThanOrEqual(200);
});

test("skills resolve by folder name, id, loose name or path, and rank for a query by name first", () => {
  const skills = [{ ...skill("office-pptx", "Make and check .pptx decks."), id: "pptx" }, skill("slides-executor", "Build any slide deck.", "Slides Executor")];
  expect(resolveSkill(skills, "office-pptx")).toMatchObject({ kind: "found", skill: { name: "office-pptx" } });
  expect(resolveSkill(skills, "pptx")).toMatchObject({ kind: "found", skill: { name: "office-pptx" } });
  expect(resolveSkill(skills, "Slides Executor")).toMatchObject({ kind: "found", skill: { name: "Slides Executor" } });
  expect(resolveSkill(skills, "/home/box/agent-data/managed-skills/slides-executor/")).toMatchObject({ kind: "found" });
  expect(resolveSkill(skills, "deck")).toEqual({ kind: "missing" });
  expect(searchSkills(skills, "slide deck").map((found) => found.name)).toEqual(["Slides Executor", "office-pptx"]);
  expect(searchSkills(skills, "the skill for my")).toEqual([]);
});
