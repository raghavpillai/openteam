export type SkillAccess = "read" | "tool";

/** knowledgeWork, the one worker with skills of its own, loads them with the Skill tool, as the reference's does. */
export const workerSkillAccess = (subagentType: string | null | undefined): SkillAccess =>
  subagentType === "knowledgeWork" ? "tool" : "read";
