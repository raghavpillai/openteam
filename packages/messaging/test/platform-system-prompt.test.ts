import { preparePromptSections } from "../src/prompt-sections";
import { describe, expect, test } from "bun:test";
import { AgentMessaging, validateSendToUserInput } from "../src";
import type { AgentPromptContext } from "../src/agent-data";
import {
  PLATFORM_BASE_SYSTEM_PROMPT,
  renderPlatformBaseSystemPrompt,
  renderPlatformRuntimeInstructions,
} from "../src/platform-system-prompt";

const mainAgent = (id: string) => {
  const profileSnapshot: AgentPromptContext["profileSnapshot"] = {
    version: 1,
    profileSection: `You are ${id}.`,
    systemIdentity: { name: id, description: "Current description" },
    announcedIdentity: { name: id, description: "Current description" },
    compactionEpoch: 4,
  };
  const memorySnapshot = { render: `Only ${id} knows this fact.`, compactionEpoch: 4 };
  const messaging = Object.create(AgentMessaging.prototype) as AgentMessaging;
  Object.assign(messaging, {
    defaultTimeZone: "Asia/Kolkata",
    agentData: {
      root: "/srv/current-agent-data",
      loadInferenceSettings: async () => ({
        providerId: "openai-codex",
        modelId: "gpt-5.5",
        reasoning: "high",
      }),
      preparePlatformSections: async (_bot: string, _context: string, epoch: number, live: Record<string, string>) => preparePromptSections({}, epoch, live),
        promptContext: async () => ({
        compactionEpoch: 4,
        profileSection: profileSnapshot.profileSection,
        profileSnapshot,
        identityAnnouncement: `<agent_profile_update>${id} renamed</agent_profile_update>`,
        memoryRender: memorySnapshot.render,
        memorySnapshot,
        skillRender: `- ${id} workflow: /srv/current-agent-data/workflows/${id}/SKILL.md`,
        warnings: [],
      }),
    },
    prisma: {
      contextSession: { findFirst: async () => ({ scope: "home" }) },
      $queryRaw: async () => [],
      bot: {
        findUniqueOrThrow: async () => ({
          id,
          name: id,
          instructions: `Follow ${id}'s preferences.`,
          hiddenFromSidebar: false,
          notificationsEnabled: true,
          defaultDirectory: `/workspace/${id}`,
          subagentIdentity: null,
          todos: [],
        }),
        findMany: async () => [],
      },
      channel: { findMany: async () => [] },
      projectMember: { findMany: async () => [] },
      botConnectorState: { findMany: async () => [] },
      routine: { findMany: async () => [] },
    },
  });
  return { messaging, profileSnapshot, memorySnapshot };
};

describe("Grok-derived platform prompt integration", () => {
  test("deployment-disabled template sharing is omitted from managed and inline workflows", () => {
    const previous = process.env.OPENTEAM_TEMPLATE_SHARING;
    process.env.OPENTEAM_TEMPLATE_SHARING = "false";
    try {
      expect(renderPlatformBaseSystemPrompt({ managedSkills: true })).not.toContain("export-bot-template");
      expect(renderPlatformBaseSystemPrompt({ managedSkills: false })).not.toContain("create_bot_share_json");
      expect(renderPlatformBaseSystemPrompt({ managedSkills: true, sharing: true })).toContain("export-bot-template");
    } finally {
      if (previous === undefined) delete process.env.OPENTEAM_TEMPLATE_SHARING;
      else process.env.OPENTEAM_TEMPLATE_SHARING = previous;
    }
  });

  test("uses a shared platform prefix with each bot's own state and separate skill context", async () => {
    for (const [id, otherId] of [
      ["alpha", "beta"],
      ["beta", "alpha"],
    ] as const) {
      const fixture = mainAgent(id);
      const prompt = await fixture.messaging.platformPrompt(id, `${id}-context`);
      expect(prompt.instructions).toStartWith(`${renderPlatformBaseSystemPrompt()}\n\nYou are ${id}.`);
      expect(prompt.instructions).toContain(`Follow ${id}'s preferences.`);
      expect(prompt.instructions).toContain(`Only ${id} knows this fact.`);
      expect(prompt.instructions).not.toContain(`Only ${otherId} knows this fact.`);
      expect(prompt.instructions).toContain(`/srv/current-agent-data/agents/${id}`);
      expect(prompt.instructions).toContain(`/srv/current-agent-data/user-memory/by-agent/${id}`);
      expect(prompt.instructions).toContain(`/workspace/${id}`);
      expect(prompt.instructions).toContain("Asia/Kolkata");
      expect(prompt.instructions).not.toContain(`/workflows/${id}/SKILL.md`);
      expect(prompt.userInfo).toContain(`/workflows/${id}/SKILL.md`);
      expect(prompt.userInfoEpoch).toBe(4);
      expect(prompt.agentProfileUpdate).toBe(
        `<agent_profile_update>${id} renamed</agent_profile_update>`
      );
      expect(prompt.agentProfileSnapshot).toBe(fixture.profileSnapshot);
      expect(prompt.memorySnapshot).toBe(fixture.memorySnapshot);
    }
  });

  test("does not instruct the model to use unsupported capture-specific mechanics", () => {
    for (const unsupported of [
      "end_turn",
      "CloudAgent",
      "CopyToBox",
      "CopyFromBox",
      "RecallMemory",
      "request_smart_mode_approval",
      "requestSmartModeApproval",
      "grokbot://",
      "/home/box/reference/",
      "Cursor-managed",
      "PROMPT_CAPTURE_BASELINE_OK",
      "Prompt Capture 0912",
      "32f70b9a-76fb-4bbf-9579-4b853e42024e",
      "Raghav Pillai",
      "America/Los_Angeles",
    ]) {
      expect(PLATFORM_BASE_SYSTEM_PROMPT).not.toContain(unsupported);
    }
    expect(PLATFORM_BASE_SYSTEM_PROMPT).toContain("output_path");
    expect(PLATFORM_BASE_SYSTEM_PROMPT).toContain("actual tool flow");
  });

  test("the copied question-widget example passes OpenTeam's real send validation", () => {
    const example = PLATFORM_BASE_SYSTEM_PROMPT.match(
      /send a question widget rather than prose: (\{.+\})\./
    )?.[1];
    expect(example).toBeDefined();
    const input = JSON.parse(example!);
    expect(() => validateSendToUserInput(input)).not.toThrow();
  });

  test("deployment context resolves timezone and paths without captured account defaults", () => {
    const prompt = renderPlatformRuntimeInstructions({
      agentDataRoot: "/var/lib/openteam/",
      botId: "current-bot",
      workingDirectory: "/work/current-project",
      timeZone: "not-a-timezone",
    });
    expect(prompt).toContain("/var/lib/openteam/agents/current-bot");
    expect(prompt).toContain("/var/lib/openteam/workflows/<slug>/SKILL.md");
    expect(prompt).toContain("configured timezone is UTC");
    expect(prompt).not.toContain("/home/box");
    expect(prompt).not.toContain("UTC-7");
  });
});
