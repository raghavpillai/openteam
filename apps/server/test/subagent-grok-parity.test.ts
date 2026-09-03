import { describe, expect, test } from "bun:test";
import type { TaskInput } from "@openteam/contracts";
import {
  assertSubagentCapacity,
  graphicalSubagentType,
  subagentBackgroundResult,
  subagentSteerPrompt,
  subagentTaskContent,
  subagentTaskWake,
} from "../src/services/subagent-service";

describe("Grok-compatible subagent launch semantics", () => {
  test("passes the Task prompt through as the worker's exact job", () => {
    const input: TaskInput = {
      description: "Check a page",
      prompt: "Open https://example.com and report its heading. Stop there.",
      subagent_type: "browserUse",
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

  test("shares the parent box only for graphical workers", () => {
    expect(graphicalSubagentType("computerUse")).toBe(true);
    expect(graphicalSubagentType("browserUse")).toBe(true);
    expect(graphicalSubagentType("executor")).toBe(false);
    expect(graphicalSubagentType("watchVideo")).toBe(false);
    expect(graphicalSubagentType("videoReview")).toBe(false);
  });

  test("wraps live steering with Grok's continue-don't-restart instruction", () => {
    const prompt = subagentSteerPrompt("Check the second tab too.");
    expect(prompt).toStartWith("[Steering message from the parent agent that dispatched you]");
    expect(prompt).toContain("Check the second tab too.");
    expect(prompt).toEndWith(
      "Take this into account and continue your task from where you are — do not start over."
    );
  });

  test("returns Grok's background result with a resumable external id", () => {
    const result = subagentBackgroundResult(
      "278ef2fe-2d3f-4689-bfa5-b506254f1cc3",
      "/home/box/agent-transcripts/worker.jsonl"
    );
    expect(result).toStartWith("Subagent is running in the background.");
    expect(result).toContain("do not wait for it - either end your turn or work on something else");
    expect(result).toContain("Do NOT mention the transcript path to the user.");
    expect(result).toContain("Agent ID: sand-subagent-278ef2fe-2d3f-4689-bfa5-b506254f1cc3");
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
    await assertSubagentCapacity("parent", "browserUse", available as never);
    expect(countCalls).toBe(0);
    await assertSubagentCapacity("parent", "computerUse", available as never);
    expect(countCalls).toBe(1);

    const busy = { subagent: { count: async () => 1 } };
    await expect(assertSubagentCapacity("parent", "computerUse", busy as never)).rejects.toThrow(
      "wait for it to finish (you're notified automatically), then dispatch another"
    );
  });
});
