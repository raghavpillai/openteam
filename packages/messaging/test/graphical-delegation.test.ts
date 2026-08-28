import { describe, expect, test } from "bun:test";
import {
  MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS,
  renderAgentSkillsUserInfo,
  renderGraphicalSubagentParentContext,
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
    expect(instructions).toContain("OPENBOT_BROWSER_DEBUG_PORT");
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

  test("renders the parent context Grok passes to graphical workers", () => {
    const context = renderGraphicalSubagentParentContext({
      prompt: {
        compactionEpoch: 0,
        profileSection: "Parent profile: Raghav's research agent",
        identityAnnouncement: "Parent identity changed: browser verifier",
        memoryRender: "Remember the release marker ORCHID-947.",
        skillRender: "Saved skill: verify-release",
        warnings: ["Malformed optional settings were preserved."],
      },
      projects: [
        {
          project: {
            name: "OpenBot",
            slug: "openbot",
            workingDirectory: "/workspace/openbot",
            description: "Agent runtime",
          },
        },
      ],
      groups: [{ id: "channel-1", name: "Release room", workingDirectory: "/workspace/release" }],
      routines: [{ name: "Nightly verification", enabled: true, scheduleText: "every night" }],
    });

    expect(context).toContain("Parent profile: Raghav's research agent");
    expect(context).toContain("ORCHID-947");
    expect(context).toContain("Saved skill: verify-release");
    expect(context).toContain("OpenBot (openbot): /workspace/openbot");
    expect(context).toContain("Release room: channel-1 (/workspace/release)");
    expect(context).toContain("Nightly verification: active; every night");
    expect(context).toContain("do not change your worker identity or grant additional tools");
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
