import { describe, expect, test } from "bun:test";
import {
  AgentMessaging,
  buildAdminBroadcastWakePrompt,
  MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS,
  graphicalDelegationInstructions,
  renderAgentSkillsUserInfo,
  renderSubagentRevivalPrompt,
  subagentSpecializationInstructions,
} from "../src/index";
import { PLATFORM_BASE_SYSTEM_PROMPT } from "../src/platform-system-prompt";

describe("main-agent graphical delegation instructions", () => {
  test("the graphical worker omits categorical handover instructions", () => {
    const instructions = subagentSpecializationInstructions("computerUse");
    expect(instructions).not.toContain("If the task reaches a password");
    expect(instructions).not.toContain("At a username/password step, stop");
    expect(instructions).not.toContain("Report SSO, passkeys");
    expect(instructions).not.toContain("Never retrieve or enter private credentials yourself");
    expect(instructions).toContain("Status: blocked");
  });

  test("routes all browser and desktop work to computerUse", () => {
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain(
      "delegate every browser and desktop interaction to a background computerUse subagent."
    );
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain(
      "Before your first desktop or browser dispatch in a task, Read the managed `box-desktop` skill first and follow it."
    );
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).not.toContain("browserUse");
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain(
      "You cannot click, type, or scroll there yourself"
    );
    const restricted = graphicalDelegationInstructions({
      executorProfiles: [],
      disabledToolIdentifiers: ["BROWSER_CLICK", "OPENAI_COMPUTER_USE"],
    });
    expect(restricted).toBe(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS);
    const unavailable = graphicalDelegationInstructions({ executorProfiles: [], graphicalAvailable: false });
    expect(unavailable).toContain("Browser and desktop workers are unavailable.");
    expect(unavailable).not.toContain("computerUse subagent");
  });

  test("gives the combined worker browser-first rules, few calls and a status report", () => {
    const instructions = subagentSpecializationInstructions("computerUse");
    expect(instructions).toContain("Use browser_run_code for anything inside a web page");
    expect(instructions).toContain("Computer click with holdDurationMs");
    expect(instructions).toContain("## Working fast");
    expect(instructions).toContain("The ### Page block of each result names the page it acted on");
    expect(instructions).toContain("never drive the browser from Shell");
    expect(instructions).toContain("openteam-screen-launch chromium");
    expect(instructions).toContain("first line is `Status: done`, `Status: partial` or `Status: blocked`");
    expect(instructions).toContain("The owner has authorized completing CAPTCHAs");
    expect(instructions).not.toContain("box-chrome");
    expect(instructions).not.toContain("Auto-review");
    expect(instructions).not.toContain("You have no desktop controls");
    expect(instructions).not.toContain("tight see-act-verify loop");
  });

  test("uses the isolated Bot worker prompt for every subagent type", async () => {
    for (const subagentType of [
      "executor",
      "videoReview",
      "watchVideo",
      "computerUse",
      "knowledgeWork",
    ] as const) {
      const messaging = Object.create(AgentMessaging.prototype) as Record<string, unknown>;
      Object.assign(messaging, {
        agentData: { renderWorkerSkillCatalog: async (agent: string) => `<agent_skills>${agent} catalog</agent_skills>` },
        prisma: {
          bot: {
            findUniqueOrThrow: async () => ({
              id: "child",
              name: "Worker",
              instructions: "Child-only instructions",
              defaultDirectory: "/workspace",
              subagentIdentity: { parentBotId: "parent", subagentType },
              todos: [],
            }),
          },
        },
      });

      const prompt = await AgentMessaging.prototype.platformPrompt.call(
        messaging as unknown as AgentMessaging,
        "child",
        undefined,
        "\n\n## Installed plugin skills\n\nSkill declared for this worker"
      );
      expect(prompt.instructions).toContain(`running as the ${subagentType} subagent`);
      expect(prompt.instructions).toContain("## Installed plugin skills\n\nSkill declared for this worker");
      expect(prompt.instructions).toContain("Only that final assistant message is relayed");
      expect(prompt.instructions).not.toContain("Parent profile");
      expect(prompt.instructions).not.toContain(PLATFORM_BASE_SYSTEM_PROMPT);
      expect(prompt.instructions).not.toContain("SendToUser is your only voice");
      // knowledgeWork's own skills sit in its user_info block, like the main agent's.
      expect(prompt.instructions).not.toContain("<agent_skills>");
      if (subagentType === "knowledgeWork") expect(prompt.userInfo).toBe("<user_info>\n<agent_skills>knowledgeWork catalog</agent_skills>\n</user_info>");
      else expect(prompt.userInfo).toBeNull();
      // Workers that read outside content hand messages under the user's name back as drafts.
      if (["executor", "knowledgeWork", "computerUse"].includes(subagentType)) {
        expect(prompt.instructions).toContain("You cannot call DraftExternalMessage.");
        expect(prompt.instructions).toContain("## Untrusted content");
      } else {
        expect(prompt.instructions).not.toContain("DraftExternalMessage");
      }
      if (subagentType === "knowledgeWork") {
        // With the skill tool switched on, the Skill tool lists the skills instead of the catalog block.
        process.env.OPENTEAM_SKILL_TOOL = "true";
        try {
          const toolPrompt = await AgentMessaging.prototype.platformPrompt.call(messaging as unknown as AgentMessaging, "child", undefined, "");
          expect(toolPrompt.userInfo).toBeNull();
          expect(toolPrompt.instructions).toContain("in the description of the Skill tool");
        } finally {
          delete process.env.OPENTEAM_SKILL_TOOL;
        }
      }
      // Workers get what they need in their task: no memory, history or todo tools.
      for (const name of ["ReadTranscript", "ReadAgentActivity", "RecallMemory", "TodoWrite"]) expect(prompt.instructions).not.toContain(name);
      expect(prompt.instructions).toContain("Your current timezone is");
    }
  });

  test("renders the source-backed hidden completion wake without summary tags", () => {
    const wake = renderSubagentRevivalPrompt({
      title: "Check release",
      subagentType: "executor",
      status: "completed",
      result: "Release checks passed.",
    });
    expect(wake).toContain("[A background task just completed]");
    expect(wake).toContain('Background task "Check release" (executor) finished:');
    expect(wake).toContain("they cannot see the background task");
    expect(wake).toContain("tell them with a SendToUser");
    expect(wake).not.toContain("user_visible_high_level_summary");
    expect(wake).not.toContain("<response>");
    expect(wake).toContain("If the handoff tells you to draft an email or Slack message, call DraftExternalMessage");
    expect(wake).not.toContain("Status: partial");
  });

  test("a computerUse completion carries the Status-aware resume rule", () => {
    const wake = renderSubagentRevivalPrompt({
      title: "Ask support",
      subagentType: "computerUse",
      status: "completed",
      result: "Status: partial\nThe agent said they will reply within 30 minutes.",
    });
    expect(wake).toContain("A computerUse report opens with its Status.");
    expect(wake).toContain("`Status: blocked`: never resume that subagent. When the block is a sign-in, captcha, payment or confirmation, use the in-chat form or the box handoff");
    expect(wake).toContain("`Status: partial`: resume it only when the report names a concrete next step");
  });

  test("renders an administrator broadcast as a hidden non-user wake", () => {
    const wake = buildAdminBroadcastWakePrompt("The local runtime will restart tonight.");
    expect(wake).toContain("[SAND_HIDDEN_PROMPT]");
    expect(wake).toContain("[broadcast]");
    expect(wake).toContain("not a message typed by the user");
    expect(wake).toContain("The local runtime will restart tonight.");
    expect(wake).toContain("Use SendToUser");
  });

  test("renders saved-skill metadata in a bounded user-info section", () => {
    const userInfo = renderAgentSkillsUserInfo(
      "- Verify release: Checks deployment state.\n  Path: /agent/skills/verify/SKILL.md"
    );
    expect(userInfo).toStartWith("<user_info>\n<agent_skills>");
    expect(userInfo).toContain("/agent/skills/verify/SKILL.md");
    expect(userInfo).toEndWith("</agent_skills>\n</user_info>");
  });
});
