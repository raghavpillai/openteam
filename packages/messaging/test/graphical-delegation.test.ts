import { describe, expect, test } from "bun:test";
import {
  AgentMessaging,
  buildAdminBroadcastWakePrompt,
  MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS,
  graphicalDelegationInstructions,
  renderAgentSkillsUserInfo,
  renderSubagentRevivalPrompt,
  renderShellCompletionPrompt,
  renderRevivalBatchPrompt,
  shellCompletionBlock,
  subagentRevivalBlock,
  describeHeldDuration,
  HELD_REVIVAL_NOTE,
  SUBAGENT_REVIVAL_INSTRUCTION,
  subagentSpecializationInstructions,
} from "../src/index";
import { PLATFORM_BASE_SYSTEM_PROMPT } from "../src/platform-system-prompt";
import { omittedSkillsNotice } from "../src/skill-catalog";

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
        "child-context",
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
      // As in the reference, an executor's prompt ends with its box section: no extra verification brief.
      if (executes) expect(prompt.instructions).toEndWith("omit it for box paths.\n\nSubagent instructions:\nChild-only instructions");
      expect(prompt.instructions).not.toMatch(/Preserve every requested success criterion|A background process starting is not proof/);
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
    const prompt = await AgentMessaging.prototype.platformPrompt.call(messaging as unknown as AgentMessaging, "child", "child-context", "");
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
    expect(wake).toContain('Background task "Check release" (executor) finished:\nRelease checks passed.\n\nPick the work back up:');
    expect(wake).not.toContain("distinguish eventual completion");
    expect(wake).toContain("they cannot see the background task");
    expect(wake).toContain("tell them with a SendToUser");
    expect(wake).not.toContain("user_visible_high_level_summary");
    expect(wake).not.toContain("<response>");
  });

  test("renders a finished background shell like a finished subagent, naming the command", () => {
    expect(renderShellCompletionPrompt({ id: "123456", scope: "bot", outputPath: "/t/123456.log", exitCode: 1, title: "npm test" })).toBe(
      [
        "[SAND_HIDDEN_PROMPT][A background task just completed] A background task you started has finished.",
        "",
        'Background task "npm test" (shell) failed:',
        "exit_code=1",
        "Full output: /t/123456.log",
        "",
        SUBAGENT_REVIVAL_INSTRUCTION,
      ].join("\n")
    );
    const host = renderShellCompletionPrompt({ id: "x", hostShellId: "77", machineId: "mac", scope: "bot", outputPath: "/h/77.log", exitCode: 0 });
    expect(host).toContain('Background task "Background command 77" (shell) finished:\nFull output: /h/77.log\nThis is on the user’s computer; use Read or AwaitShell with machineId "mac".\n');
  });

  test("batches completions that are ready together and dates the late ones", () => {
    const report = subagentRevivalBlock({ title: "Find flights", subagentType: "executor", status: "completed", result: "Two nonstops found.\n" });
    const shell = shellCompletionBlock({ id: "9", scope: "bot", outputPath: "/t/9.log", exitCode: 2, title: "npm test" });
    expect(report).toBe('Background task "Find flights" (executor) finished:\nTwo nonstops found.');
    expect(renderRevivalBatchPrompt([
      { block: report, subagentType: "executor" },
      { block: shell, subagentType: "shell", heldForMs: 7 * 60_000 + 10_000 },
    ])).toBe([
      "[SAND_HIDDEN_PROMPT][A background task just completed] 2 background tasks you started have finished.",
      "",
      'Background task "Find flights" (executor) finished:\nTwo nonstops found.',
      "",
      'Background task "npm test" (shell) failed:\nexit_code=2\nFull output: /t/9.log\n(This finished about 7 minutes ago and reached you only now, so it may be out of date.)',
      "",
      SUBAGENT_REVIVAL_INSTRUCTION,
      HELD_REVIVAL_NOTE,
    ].join("\n"));
    expect(HELD_REVIVAL_NOTE).toBe("Some of these results were held back and arrive late; each one says how long it waited. Judge each by its age: act on it only if it is still current, and skip it if it is stale, already handled, or overtaken by a newer result. Never fold a held result into a reply about something else the user asked.");
    const room = "This work belongs to group room \"Launch\".";
    const single = renderRevivalBatchPrompt([{ block: report, subagentType: "executor", note: room, heldForMs: 2 * 3_600_000 }]);
    expect(single).toStartWith("[SAND_HIDDEN_PROMPT][A background task just completed] A background task you started has finished.\n");
    expect(single).toContain("(This finished about 2 hours ago and reached you only now");
    expect(single).toEndWith(`${HELD_REVIVAL_NOTE}\n\n${room}`);
    expect([30_000, 60_000, 89 * 60_000, 90 * 60_000, 47 * 3_600_000, 50 * 3_600_000].map(describeHeldDuration))
      .toEqual(["1 minute", "1 minute", "89 minutes", "2 hours", "47 hours", "2 days"]);
  });

  test("renders an administrator broadcast as a hidden non-user wake", () => {
    const wake = buildAdminBroadcastWakePrompt("The local runtime will restart tonight.");
    expect(wake).toContain("[SAND_HIDDEN_PROMPT]");
    expect(wake).toContain("[broadcast]");
    expect(wake).toContain("not a message typed by the user");
    expect(wake).toContain("The local runtime will restart tonight.");
    expect(wake).toContain("Use SendToUser");
  });

  test("renders the main skill catalog after user_info with the reference preamble", () => {
    const item = '<agent_skill fullPath="/agent/skills/verify/SKILL.md">Checks deployment state.</agent_skill>';
    const userInfo = renderAgentSkillsUserInfo(item, "<memory_context>\nfacts\n</memory_context>", "<teammates>\nroster\n</teammates>", "Wednesday Oct 21, 2026");
    expect(userInfo).toBe([
      "<user_info>\nToday's date: Wednesday Oct 21, 2026\n</user_info>",
      "<memory_context>\nfacts\n</memory_context>",
      "<teammates>\nroster\n</teammates>",
      [
        "<agent_skills>",
        "When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge. To use a skill, read the skill file at the provided absolute path using the Read tool, then follow the instructions within. When a skill is relevant, read and follow it IMMEDIATELY as your first action. NEVER just announce or mention a skill without actually reading and following it. Only use skills listed below.",
        "",
        "",
        '<available_skills description="Skills the agent can use. Use the Read tool with the provided absolute path to fetch full contents.">',
        item,
        "</available_skills>",
        "</agent_skills>",
      ].join("\n"),
    ].join("\n\n"));
    expect(renderAgentSkillsUserInfo("")).toBe("<user_info>\n</user_info>");
    const omitted = renderAgentSkillsUserInfo(`${item}\n\n${omittedSkillsNotice(3, ["/agent/workflows"])}`);
    expect(omitted).toContain("NEVER just announce or mention a skill without actually reading and following it. Use the skills listed below. If a later task specifically requires discovering more skills, additional skills may exist in the directories shown in the skills section.");
    expect(omitted).toContain(`${item}\n\nAdditional skills omitted from this initial list (3). Directories containing omitted skills: /agent/workflows.\n</available_skills>`);
  });
});
