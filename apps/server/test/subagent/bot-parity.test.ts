import { describe, expect, test } from "bun:test";
import type { TaskInput } from "@openteam/contracts";
import {
  assertSubagentCapacity,
  SubagentService,
  subagentBackgroundResult,
  subagentForegroundResult,
  subagentSteerPrompt,
  subagentTaskContent,
  subagentTaskWake,
} from "../../src/services/subagent/service";

describe("OpenTeam-compatible subagent launch semantics", () => {
  test("passes the Task prompt through as the worker's exact job", () => {
    const input: TaskInput = {
      description: "Check a page",
      prompt: "Open https://example.com and report its heading. Stop there.",
      subagent_type: "computerUse",
      file_attachments: ["/workspace/shared/reference.png"],
      run_in_background: true,
    };
    expect(subagentTaskContent(input)).toBe(input.prompt);
    expect(subagentTaskContent(input)).not.toContain("Background task");
    expect(subagentTaskContent(input)).not.toContain("user_visible_high_level_summary");
    expect(subagentTaskWake(input)).toEqual({
      content: input.prompt,
      wrapUserContent: false,
    });
  });

  test("a computerUse task that names OpenTable or Resy carries the site's notes", () => {
    const input: TaskInput = { description: "Tables", prompt: "Check Resy for a table for two tonight.", subagent_type: "computerUse" };
    expect(subagentTaskContent(input)).toStartWith(`${input.prompt}\n\nResy notes, for checking open tables or booking on Resy.`);
    expect(subagentTaskContent({ ...input, subagent_type: "executor" })).toBe(input.prompt);
    // A resume names no type; the child's own type decides.
    expect(subagentTaskWake({ ...input, subagent_type: undefined, resume: "sand-subagent-1" }, "computerUse").content).toContain("Resy notes");
  });

  test("wraps live steering with Bot's continue-don't-restart instruction", () => {
    expect(subagentSteerPrompt("  Check the second tab too.\n")).toBe(
      "[Steering message from the parent agent that dispatched you]\n\nCheck the second tab too.\n\nTake this into account and continue your task from where you are. Do not start over."
    );
  });

  test("returns Bot's background result with a resumable external id", () => {
    expect(subagentBackgroundResult("278ef2fe-2d3f-4689-bfa5-b506254f1cc3")).toBe(
      "Subagent is running in the background. When you end your turn, you will be automatically sent the subagent's final response upon its completion, so do not wait for it - either end your turn or work on something else.\n\nAgent ID: sand-subagent-278ef2fe-2d3f-4689-bfa5-b506254f1cc3 (can be used with the `resume` parameter to send a follow-up after it completes)"
    );
    expect(subagentForegroundResult("1", "Found 3 flights.")).toBe(
      "This is the output of the subagent:\n\nresponse:\n<response>\nFound 3 flights.\n</response>\n\nAgent ID: sand-subagent-1 (can be used with the `resume` parameter to send a follow-up after it completes)"
    );
  });

  test("has no generic child pool cap and locks only computerUse per parent", async () => {
    let countCalls = 0;
    const available = {
      subagent: {
        count: async ({ where }: { where: Record<string, unknown> }) => {
          countCalls += 1;
          expect(where).toMatchObject({
            parentBotId: "parent",
            subagentType: "computerUse",
            status: { in: ["provisioning", "queued", "running"] },
          });
          return 0;
        },
      },
    };

    await assertSubagentCapacity("parent", "executor", available as never);
    await assertSubagentCapacity("parent", "knowledgeWork", available as never);
    expect(countCalls).toBe(0);
    await assertSubagentCapacity("parent", "computerUse", available as never);
    expect(countCalls).toBe(1);

    const busy = { subagent: { count: async () => 1 } };
    await expect(assertSubagentCapacity("parent", "computerUse", busy as never)).rejects.toThrow(
      "Only one can run at a time. Wait for it to finish (you're notified automatically), then dispatch another."
    );
  });
});
