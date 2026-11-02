/** Worker types that also carry a managed skill in their own catalog. Every managed skill is in the main agent's catalog. */
export const managedSkillAgents = (skill: object): string[] | undefined => {
  const agents = (skill as { agents?: unknown }).agents;
  return Array.isArray(agents) && agents.every((agent) => typeof agent === "string")
    ? (agents as string[])
    : undefined;
};

