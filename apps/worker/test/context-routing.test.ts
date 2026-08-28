import { describe, expect, test } from "bun:test";
import {
  automationTriggerForWake,
  contextScopeForRun,
  wakeResetsSelfSummaryCount,
} from "../src/worker";

describe("Grok-style runtime context routing", () => {
  test("uses the member home context for groups, DM, A2A, routines, bootstrap, and subagents", () => {
    const conversationId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    expect(contextScopeForRun("group", groupId, conversationId)).toEqual({
      scope: "home",
      scopeId: conversationId,
    });
    for (const origin of ["user", "agent", "routine", "bootstrap"] as const) {
      expect(contextScopeForRun(origin, groupId, conversationId)).toEqual({
        scope: "home",
        scopeId: conversationId,
      });
    }
  });

  test("does not let a malformed group channel change the member home context", () => {
    const conversationId = crypto.randomUUID();
    expect(contextScopeForRun("group", null, conversationId)).toEqual({
      scope: "home",
      scopeId: conversationId,
    });
  });

  test("resets summary counts for hidden wakes except background-task completion", () => {
    for (const type of [
      "agent.message",
      "group.message",
      "routine.scheduled",
      "subagent.task",
      "subagent.resume",
    ]) {
      expect(wakeResetsSelfSummaryCount(type)).toBe(true);
    }
    expect(wakeResetsSelfSummaryCount("subagent.completed")).toBe(false);
    expect(wakeResetsSelfSummaryCount("subagent.failed")).toBe(false);
    expect(wakeResetsSelfSummaryCount("subagent.stopped")).toBe(false);
    expect(wakeResetsSelfSummaryCount("subagent.cancelled")).toBe(false);
  });

  test("carries only the original tagged automation trigger for routine wakes", () => {
    const tagged =
      "<automation_trigger_info>\nRoutine: audit\n</automation_trigger_info>\nRun it now.";
    expect(automationTriggerForWake("routine", tagged)).toBe(
      "<automation_trigger_info>\nRoutine: audit\n</automation_trigger_info>"
    );
    expect(
      automationTriggerForWake(
        "routine",
        "Routine wake text has no tags.",
        "<automation_trigger_info>\nRoutine: supplied\n</automation_trigger_info>"
      )
    ).toContain("Routine: supplied");
    expect(automationTriggerForWake("agent", tagged)).toBeNull();
    expect(automationTriggerForWake("routine", "untagged routine")).toBeNull();
  });
});
