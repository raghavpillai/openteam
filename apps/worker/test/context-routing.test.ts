import { describe, expect, test } from "bun:test";
import {
  automationTriggerForWake,
  contextScopeForRun,
  runtimeRequestSourceForOrigin,
  turnContentWithNotes,
  wakeResetsSelfSummaryCount,
} from "../src/worker";

describe("OpenTeam-style runtime context routing", () => {
  test("isolates each room for groups, DM, A2A, bootstrap, and events", () => {
    const conversationId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    expect(contextScopeForRun("group", groupId, conversationId)).toEqual({
      scope: "channel",
      scopeId: groupId,
    });
    for (const origin of ["user", "agent", "bootstrap", "event"] as const) {
      expect(contextScopeForRun(origin, groupId, conversationId)).toEqual({
        scope: "channel",
        scopeId: groupId,
      });
    }
  });

  test("isolates automation runs while continuations reuse the automation context", () => {
    const conversation = crypto.randomUUID(), first = crypto.randomUUID(), second = crypto.randomUUID();
    expect(contextScopeForRun("routine", null, conversation, first)).toEqual({ scope: "automation", scopeId: first });
    expect(contextScopeForRun("routine", null, conversation, second).scopeId).not.toBe(first);
    expect(() => contextScopeForRun("routine", null, conversation)).toThrow("own context run ID");
    expect(contextScopeForRun("background_revival", null, conversation, first).scopeId).toBe(conversation);
  });

  test("does not let a malformed group channel change the member home context", () => {
    const conversationId = crypto.randomUUID();
    expect(contextScopeForRun("group", null, conversationId)).toEqual({
      scope: "home",
      scopeId: conversationId,
    });
  });

  test("maps durable origins to Bot's exact active request-source names", () => {
    expect(runtimeRequestSourceForOrigin("user")).toBe("turn");
    expect(runtimeRequestSourceForOrigin("bootstrap")).toBe("turn");
    expect(runtimeRequestSourceForOrigin("agent")).toBe("agent");
    expect(runtimeRequestSourceForOrigin("group")).toBe("agent");
    expect(runtimeRequestSourceForOrigin("routine")).toBe("automation");
    expect(runtimeRequestSourceForOrigin("event")).toBe("event");
    expect(runtimeRequestSourceForOrigin("background_revival")).toBe("background-revival");
    expect(runtimeRequestSourceForOrigin("handoff_resume")).toBe("handoff-resume");
    expect(runtimeRequestSourceForOrigin("broadcast")).toBe("broadcast");
  });

  test("does not reset summary counts for event taps or background-task completion", () => {
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
    expect(wakeResetsSelfSummaryCount("timeline.event")).toBe(false);
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

  test("puts turn notes in one reminder block ahead of the timestamped query", () => {
    const update = "[SAND_HIDDEN_PROMPT]<<SAND_AGENT_PROFILE_UPDATE:v1:fixture>>\n<agent_profile_update>\n</agent_profile_update>";
    const sections = "<instructions_update>\nchanged\n</instructions_update>";
    const query = "<timestamp>Monday, Oct 20, 2026, 9:00 AM (UTC)</timestamp>\n<user_query>\nhi\n</user_query>";
    expect(turnContentWithNotes({ origin: "user", runtimeProfile: "agent", notes: [update, null, sections] }, query)).toBe([
      "<system_reminder>",
      update,
      "",
      sections,
      "",
      "Reply to this message by actually invoking the SendToUser tool. Make a real tool/function call, not text you write. Plain assistant text is NEVER delivered; only a real SendToUser tool invocation reaches the user, so if you don't invoke the tool they just see silence.",
      "</system_reminder>",
      query,
    ].join("\n"));
    // Hidden host prompts and non-user wakes keep their notes but get no reply reminder.
    expect(turnContentWithNotes({ origin: "agent", runtimeProfile: "agent", notes: [update] }, "[event]\n- Renamed to Test")).toBe(
      `<system_reminder>\n${update}\n</system_reminder>\n[event]\n- Renamed to Test`
    );
    expect(turnContentWithNotes({ origin: "user", runtimeProfile: "agent", notes: [] }, "[SAND_HIDDEN_PROMPT]form")).toBe("[SAND_HIDDEN_PROMPT]form");
    expect(turnContentWithNotes({ origin: "user", runtimeProfile: "subagent", notes: [null] }, query)).toBe(query);
    expect(turnContentWithNotes({ origin: "user", runtimeProfile: "agent", notes: [], unfinishedTasks: true }, query)).toStartWith(
      "<system_reminder>\nThe user interrupted your work to send you a message. Follow the new message first."
    );
  });
});
