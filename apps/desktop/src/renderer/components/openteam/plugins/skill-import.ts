import { parseSkillMarkdown } from "@openteam/plugin-sdk/skill-markdown";

/** Keep the YAML parser behind an explicit import action. */
export const readSkillImport = (text: string, fallbackName: string) =>
  parseSkillMarkdown(text, fallbackName);
