import { describe, expect, test } from "bun:test";
import {
  AgentMessaging,
  buildAdminBroadcastWakePrompt,
  MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS,
  renderAgentSkillsUserInfo,
  renderSubagentRevivalPrompt,
  subagentSpecializationInstructions,
} from "../src/index";

describe("main-agent graphical delegation instructions", () => {
  test("routes browser and desktop work to their specialized subagents", () => {
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain("subagent_type browserUse");
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain("subagent_type computerUse");
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain(
      "Do not attempt graphical interaction yourself"
    );
  });

  test("gives computerUse the documented recovery and safety loop", () => {
    const instructions = subagentSpecializationInstructions("computerUse");
    expect(instructions).toContain("tight see-act-verify loop");
    expect(instructions).toContain("OPENTEAM_BROWSER_DEBUG_PORT");
    expect(instructions).toContain("playwright-core");
    expect(instructions).toContain("Never use `pkill -f`");
    expect(instructions).toContain("You cannot talk to the user directly");
  });

  test("gives browserUse leased-tab, ref, and human-blocker rules", () => {
    const instructions = subagentSpecializationInstructions("browserUse");
    expect(instructions).toContain("leased tabs");
    expect(instructions).toContain("exact DOM nodes");
    expect(instructions).toContain("CAPTCHA");
    expect(instructions).toContain("You cannot talk to the user directly");
  });

  test("uses the isolated Bot worker prompt for every subagent type", async () => {
    for (const subagentType of [
      "executor",
      "videoReview",
      "watchVideo",
      "computerUse",
      "browserUse",
    ] as const) {
      const messaging = Object.create(AgentMessaging.prototype) as Record<string, unknown>;
      Object.assign(messaging, {
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
        "child"
      );
      expect(prompt.instructions).toContain(`running as the ${subagentType} subagent`);
      expect(prompt.instructions).toContain("Only that final assistant message is relayed");
      expect(prompt.instructions).not.toContain("Parent profile");
      if (subagentType === "computerUse" || subagentType === "browserUse") {
        expect(prompt.instructions).not.toContain("Your current timezone is");
      } else {
        expect(prompt.instructions).toContain("Your current timezone is");
      }
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
