import { describe, expect, test } from "bun:test";
import type { TaskInput } from "@openbot/contracts";
import {
  assertSubagentCapacity,
  graphicalSubagentType,
  subagentTaskContent,
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
  });

  test("shares the parent box only for graphical workers", () => {
    expect(graphicalSubagentType("computerUse")).toBe(true);
    expect(graphicalSubagentType("browserUse")).toBe(true);
    expect(graphicalSubagentType("executor")).toBe(false);
    expect(graphicalSubagentType("watchVideo")).toBe(false);
    expect(graphicalSubagentType("videoReview")).toBe(false);
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
      "A computerUse subagent is already using the box's desktop"
    );
  });
});
