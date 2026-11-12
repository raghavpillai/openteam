import { describe, expect, test } from "bun:test";
import { taskProgressBaseInstructions } from "@openteam/contracts/task-progress";
import {
  AgentMessaging,
  PLATFORM_PROMPT_PEER_LIMIT,
  renderTeammatesUserInfo,
  selectPlatformPromptPeers,
  validateSendToUserInput,
} from "../src";
import type { AgentPromptContext } from "../src/agent-data";
import {
  PARALLEL_TOOL_CALLS,
  PLATFORM_BASE_SYSTEM_PROMPT,
  renderPlatformBaseSystemPrompt,
} from "../src/platform-system-prompt";
import { preparePromptSections } from "../src/prompt-sections";

const mainAgent = (id: string) => {
  const profileSnapshot: AgentPromptContext["profileSnapshot"] = {
    version: 1,
    profileSection: `You are ${id}.`,
    systemIdentity: { name: id, description: "Current description" },
    announcedIdentity: { name: id, description: "Current description" },
    compactionEpoch: 4,
  };
  const messaging = Object.create(AgentMessaging.prototype) as AgentMessaging;
  Object.assign(messaging, {
    userTimeZone: async () => "Asia/Kolkata",
    agentData: {
      root: "/srv/current-agent-data",
      loadTaskConfiguration: async () => ({ executorProfiles: [] }),
      loadInferenceSettings: async () => ({ providerId: "openai-codex", modelId: "gpt-5.5", reasoning: "high" }),
      preparePlatformSections: async (_bot: string, _context: string, epoch: number, live: Record<string, string>, pinned: { facts: string }) =>
        ({ ...preparePromptSections({}, epoch, live), memory: { facts: pinned.facts, update: null } }),
      promptContext: async () => ({
        compactionEpoch: 4,
        profileSection: profileSnapshot.profileSection,
        profileSnapshot,
        identityAnnouncement: `<agent_profile_update>${id} renamed</agent_profile_update>`,
        memory: { policy: `## Memory\n${id}'s memory policy.`, facts: `- (learned 2026-10-01) Only ${id} knows this fact.` },
        skillRender: `<agent_skill fullPath="/srv/current-agent-data/workflows/${id}/SKILL.md">${id} workflow</agent_skill>`,
        warnings: [],
      }),
    },
    prisma: {
      run: { findMany: async () => [] },
      contextSession: { findFirst: async () => ({ scope: "home" }), findMany: async () => [] },
      $queryRaw: async () => [],
      bot: {
        findUniqueOrThrow: async () => ({
          id, name: id, hiddenFromSidebar: false, notificationsEnabled: true,
          defaultDirectory: `/workspace/${id}`, subagentIdentity: null, todos: [],
        }),
        findMany: async () => [],
      },
      channel: { findMany: async () => [] },
      botConnectorState: { findMany: async () => [] },
      routine: { findMany: async () => [] },
    },
  });
  return { messaging, profileSnapshot };
};

const worker = (subagentType: string, readOnly = false) => {
  const messaging = Object.create(AgentMessaging.prototype) as Record<string, unknown>;
  Object.assign(messaging, {
    userTimeZone: async () => "Europe/Paris",
    agentData: { renderWorkerSkillCatalog: async (agent: string) => `<agent_skills>${agent} catalog</agent_skills>` },
    prisma: { bot: { findUniqueOrThrow: async () => ({
      id: "child", name: "Worker", defaultDirectory: "/workspace", todos: [],
      subagentIdentity: { parentBotId: "parent", subagentType, readOnly },
    }) } },
  });
  return AgentMessaging.prototype.platformPrompt.call(
    messaging as unknown as AgentMessaging, "child", "child-context", "\n\n## Installed plugin skills\n\nSkill declared for this worker"
  );
};

describe("main-agent prompt assembly", () => {
  test("each bot gets the shared prefix with its own state; memory facts and skills go to user_info", async () => {
    for (const [id, otherId] of [["alpha", "beta"], ["beta", "alpha"]] as const) {
      const fixture = mainAgent(id);
      const prompt = await fixture.messaging.platformPrompt(id, `${id}-context`);
      expect(prompt.instructions).toStartWith(`${renderPlatformBaseSystemPrompt()}\n\nYou are ${id}.`);
      expect(prompt.instructions).toContain(`${id}'s memory policy.`);
      expect(prompt.instructions).not.toContain(`Only ${id} knows this fact.`);
      expect(prompt.instructions).not.toContain(`/workflows/${id}/SKILL.md`);
      expect(prompt.instructions).toContain(`/srv/current-agent-data/agents/${id}`);
      expect(prompt.instructions).toContain(`/workspace/${id}`);
      expect(prompt.instructions).toContain("Asia/Kolkata");
      expect(prompt.userInfo).toStartWith("<user_info>\nToday's date: ");
      expect(prompt.userInfo).toContain(`<memory_context>`);
      expect(prompt.userInfo).toContain(`Only ${id} knows this fact.`);
      expect(prompt.userInfo).not.toContain(`Only ${otherId} knows this fact.`);
      expect(prompt.userInfo).toContain(`/workflows/${id}/SKILL.md`);
      expect(prompt.userInfoEpoch).toBe(4);
      expect(prompt.agentProfileUpdate).toBe(`<agent_profile_update>${id} renamed</agent_profile_update>`);
      expect(prompt.agentProfileSnapshot).toBe(fixture.profileSnapshot);
      // Task progress strips everything after the base instructions, which end on the parallel-calls line.
      expect(taskProgressBaseInstructions(prompt.instructions)).toEndWith(`\n\n${PARALLEL_TOOL_CALLS}`);
    }
  });

  test("per-turn state stays out of the instructions; todos ride on their own update", async () => {
    const { messaging } = mainAgent("alpha");
    const prisma = (messaging as unknown as { prisma: Record<string, any> }).prisma;
    const bot = await prisma.bot.findUniqueOrThrow();
    prisma.bot.findUniqueOrThrow = async () => ({ ...bot, todos: [{ id: "t1", status: "pending", content: "Book flights" }] });
    prisma.contextSession.findMany = async () => [{ id: "s2", scopeId: "c2", updatedAt: new Date() }];
    prisma.channel.findMany = async (args: { where?: { kind?: unknown } }) =>
      args.where?.kind === "group" ? [] : [{ id: "c2", name: "Trip planning", kind: "bot_dm" }];
    const prompt = await messaging.platformPrompt("alpha", "alpha-context", "\n\n## Installed plugin skills\n\nPlugin skill text");
    const order = ["alpha's memory policy.", "## Other active conversations", "## Routines\n", "## Skills\n", "## Teammates and groups\n", "## Installed plugin skills", "## Your box\n"]
      .map((part) => prompt.instructions.indexOf(part));
    expect(order.every((at, index) => at > (order[index - 1] ?? 0))).toBe(true);
    expect(prompt.instructions.split("alpha's memory policy.").length - 1).toBe(1);
    for (const gone of ["<available_subagent_types>", "Book flights", "hiddenFromSidebar="]) expect(prompt.instructions).not.toContain(gone);
    expect(prompt.todoUpdate).toBe("- **PENDING**: Book flights (id: t1)");
  });

  test.each(["user", "routine"])("an unanswered question is noted once for a %s wake, then acknowledged", async (origin) => {
    const { messaging } = mainAgent("alpha");
    const executed: string[] = [];
    Object.assign((messaging as any).prisma, {
      $queryRaw: async () => [{ id: "00000000-0000-4000-8000-000000000001", content: "Want me to watch for a reply?", metadata: { type: "widget" } }],
      $executeRaw: async (query: { strings?: readonly string[] }) => { executed.push((query.strings ?? []).join("?")); return 1; },
      automationResult: { findMany: async () => [] },
    });
    const prompt = await messaging.platformPrompt("alpha", "alpha-context", "", undefined, undefined, origin as "user");
    expect(prompt.ambientContext).toContain('"Want me to watch for a reply?"');
    expect(prompt.acknowledgement?.unansweredMessageIds).toEqual(["00000000-0000-4000-8000-000000000001"]);
    (messaging as any).agentData.acknowledgePlatformSections = async () => {};
    await messaging.acknowledgePlatformPrompt("alpha", "alpha-context", prompt);
    expect(executed.some((query) => query.includes('"widgetUnansweredEchoed":true'))).toBe(true);
  });

  test("a run's Task configuration snapshot wins over current deployment settings", async () => {
    const { messaging } = mainAgent("alpha");
    const prompt = await messaging.platformPrompt("alpha", "alpha-context", "", undefined, {
      graphicalAvailable: false,
      executorProfiles: [{ name: "quick", description: "Small jobs", providerId: "openai", modelId: "fixture", reasoning: "low" }],
    });
    expect(prompt.instructions).toContain("Browser and desktop workers are unavailable.");
    expect(prompt.instructions).not.toContain("quick: Small jobs");
  });

  test("every feature combination stays within the prompt budget", () => {
    for (const managedSkills of [true, false])
      for (const sharing of [true, false])
        expect(renderPlatformBaseSystemPrompt({ managedSkills, sharing }).length).toBeLessThan(40_000);
  });

  test("the question-widget example in the prompt passes real send validation", () => {
    const example = PLATFORM_BASE_SYSTEM_PROMPT.match(/send a question widget instead of prose: (\{.+\})\./)?.[1];
    expect(example).toBeDefined();
    expect(() => validateSendToUserInput(JSON.parse(example!))).not.toThrow();
  });
});

describe("subagent prompt assembly", () => {
  test.each(["executor", "videoReview", "watchVideo", "computerUse", "knowledgeWork"])("%s gets an isolated worker prompt", async (subagentType) => {
    const prompt = await worker(subagentType);
    expect(prompt.instructions).not.toContain(PLATFORM_BASE_SYSTEM_PROMPT);
    expect(prompt.instructions).not.toContain("<agent_skills>");
    for (const name of ["ReadTranscript", "ReadAgentActivity", "RecallMemory", "TodoWrite"]) expect(prompt.instructions).not.toContain(name);
    const userInfo = /^<user_info>\nToday's date: \w+ \w+ \d+, \d{4}\n<\/user_info>/;
    if (subagentType === "knowledgeWork") expect(prompt.userInfo).toEndWith("</user_info>\n\n<agent_skills>knowledgeWork catalog</agent_skills>");
    else if (subagentType === "executor") expect(prompt.userInfo).toMatch(new RegExp(`${userInfo.source}$`));
    else expect(prompt.userInfo).toBeNull();
    if (subagentType === "videoReview" || subagentType === "watchVideo") {
      // A media worker's prompt is the whole review brief: no tools or plugin skills.
      expect(prompt.instructions).not.toContain("Installed plugin skills");
      return;
    }
    expect(prompt.instructions).toContain(`running as the ${subagentType} subagent`);
    expect(prompt.instructions).toContain("## Installed plugin skills\n\nSkill declared for this worker");
    const executes = subagentType === "executor" || subagentType === "knowledgeWork";
    expect(prompt.instructions.includes("## Time\nThe user lives in Europe/Paris")).toBe(executes);
    expect(prompt.instructions.includes("ListMachines")).toBe(executes);
  });

  test("a read-only worker is told so and kept off the user's computers", async () => {
    const prompt = await worker("executor", true);
    expect(prompt.instructions).toContain("Operate in readonly mode: do not modify anything.");
    expect(prompt.instructions).not.toContain("ListMachines");
  });

});

describe("teammates roster", () => {
  const peers = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `agent-${index.toString().padStart(5, "0")}`, name: `Agent ${index}`, hiddenFromSidebar: index % 3 === 0,
  }));

  test("stays the same bounded size at 1k and 10k bots", () => {
    const render = (count: number) => renderTeammatesUserInfo({
      peers: selectPlatformPromptPeers([], peers(count)), groups: [], agentsRoot: "/agent-data/agents", morePeers: true,
    })!;
    expect(render(1_000)).toBe(render(10_000));
    expect(Buffer.byteLength(render(10_000))).toBeLessThan(4_000);
    expect(selectPlatformPromptPeers([], peers(10_000))).toHaveLength(PLATFORM_PROMPT_PEER_LIMIT);
  });

});
