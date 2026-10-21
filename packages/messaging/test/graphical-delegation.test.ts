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
      "For browser or desktop interaction, delegate with Task using subagent_type computerUse."
    );
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).not.toContain("browserUse");
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain(
      "Do not attempt graphical interaction yourself"
    );
    const restricted = graphicalDelegationInstructions({
      executorProfiles: [],
      disabledToolIdentifiers: ["BROWSER_CLICK", "OPENAI_COMPUTER_USE"],
    });
    expect(restricted).toBe(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS);
    const unavailable = graphicalDelegationInstructions({ executorProfiles: [], graphicalAvailable: false });
    expect(unavailable).toContain("Browser and desktop workers are unavailable.");
    expect(unavailable).not.toContain("subagent_type computerUse");
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
        defaultTimeZone: "Europe/Paris",
        agentData: { renderWorkerSkillCatalog: async (agent: string) => `<agent_skills>${agent} catalog</agent_skills>` },
        prisma: {
          bot: {
            findUniqueOrThrow: async () => ({
              id: "child",
              name: "Worker",
              instructions: "Child-only instructions",
              defaultDirectory: "/workspace",
              subagentIdentity: { parentBotId: "parent", subagentType, readOnly: false },
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
      const media = subagentType === "videoReview" || subagentType === "watchVideo";
      const executes = subagentType === "executor" || subagentType === "knowledgeWork";
      expect(prompt.instructions).not.toContain("Parent profile");
      expect(prompt.instructions).not.toContain(PLATFORM_BASE_SYSTEM_PROMPT);
      expect(prompt.instructions).not.toContain("SendToUser is your only voice");
      // knowledgeWork's own skills sit in its user_info block, like the main agent's.
      expect(prompt.instructions).not.toContain("<agent_skills>");
      if (subagentType === "knowledgeWork") expect(prompt.userInfo).toBe("<user_info>\n<agent_skills>knowledgeWork catalog</agent_skills>\n</user_info>");
      else expect(prompt.userInfo).toBeNull();
      // Workers get what they need in their task: no memory, history or todo tools.
      for (const name of ["ReadTranscript", "ReadAgentActivity", "RecallMemory", "TodoWrite"]) expect(prompt.instructions).not.toContain(name);
      expect(prompt.instructions).not.toContain("Do not call SendToUser or SendToAgent.");
      expect(prompt.instructions).not.toContain("Your current timezone is");
      if (media) {
        // A media worker's prompt is the whole review brief, with no tools or plugin skills to describe.
        expect(prompt.instructions).toStartWith("You are running as a subagent under a parent agent.");
        expect(prompt.instructions).toContain("**Accuracy is paramount** - The parent agent cannot see what you see.");
        expect(prompt.instructions).toContain("You see sampled still frames, not audio; say so when a question depends on sound or on motion between frames.");
        expect(prompt.instructions).not.toMatch(/coding agent|Canvas|DraftExternalMessage|Installed plugin skills|Child-only/);
        continue;
      }
      expect(prompt.instructions).toContain(`running as the ${subagentType} subagent`);
      expect(prompt.instructions).toContain("## Installed plugin skills\n\nSkill declared for this worker");
      expect(prompt.instructions).toContain("Only that final assistant message is relayed");
      expect(prompt.instructions).toContain("Subagent instructions:\nChild-only instructions");
      // Workers that read outside content hand messages under the user's name back as drafts, written as the user.
      expect(prompt.instructions).toContain("You cannot call DraftExternalMessage.");
      expect(prompt.instructions).toContain("## Untrusted content");
      expect(prompt.instructions).toContain("When acting through your user's accounts and apps, such as Slack, speak as them and never refer to them in the third person.");
      // Executors keep the box clock and machines straight; the browser worker works on its desktop only.
      expect(prompt.instructions.includes("## Time\nThe user lives in Europe/Paris (currently UTC+")).toBe(executes);
      expect(prompt.instructions.includes("Call ListMachines to choose one of the user's registered computers")).toBe(executes);
      expect(prompt.instructions).toContain("## Your box");
      expect(prompt.instructions).not.toContain("CopyToBox");
    }
  });

  test("a read-only worker is told so, and its box section keeps it off the user's computers", async () => {
    const messaging = Object.create(AgentMessaging.prototype) as Record<string, unknown>;
    Object.assign(messaging, {
      defaultTimeZone: "UTC",
      agentData: { renderWorkerSkillCatalog: async () => "" },
      prisma: { bot: { findUniqueOrThrow: async () => ({ id: "child", name: "Worker", instructions: "", defaultDirectory: "/workspace",
        subagentIdentity: { parentBotId: "parent", subagentType: "executor", readOnly: true }, todos: [] }) } },
    });
    const prompt = await AgentMessaging.prototype.platformPrompt.call(messaging as unknown as AgentMessaging, "child", undefined, "");
    expect(prompt.instructions).toContain("just do the work and report what you found or did.\nOperate in readonly mode: do not modify anything.");
    expect(prompt.instructions).toContain("- The user's own computers are out of reach in this run");
    expect(prompt.instructions).not.toContain("ListMachines");
    expect(prompt.instructions).toContain("The user lives in UTC (currently UTC+0)");
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
