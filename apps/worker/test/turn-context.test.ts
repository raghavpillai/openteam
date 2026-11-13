import { describe, expect, test } from "bun:test";
import { timestampUserTurn } from "@openteam/messaging";
import {
  contextScopeForRun,
  resolveTurnMemoryExchange,
  runtimeRequestSourceForOrigin,
  TurnStoppedError,
  turnCompletionFailure,
  turnContentWithNotes,
  wakeResetsSelfSummaryCount,
} from "../src/worker";

describe("OpenTeam-style runtime context routing", () => {
  test("isolates each room for groups, DM, A2A, bootstrap, and events, and a malformed group keeps the home context", () => {
    const conversationId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    for (const origin of ["group", "user", "agent", "bootstrap", "event"] as const)
      expect(contextScopeForRun(origin, groupId, conversationId)).toEqual({ scope: "channel", scopeId: groupId });
    expect(contextScopeForRun("group", null, conversationId)).toEqual({ scope: "home", scopeId: conversationId });
  });

  test("isolates automation runs while continuations reuse the automation context", () => {
    const conversation = crypto.randomUUID(), first = crypto.randomUUID(), second = crypto.randomUUID();
    expect(contextScopeForRun("routine", null, conversation, first)).toEqual({ scope: "automation", scopeId: first });
    expect(contextScopeForRun("routine", null, conversation, second).scopeId).not.toBe(first);
    expect(() => contextScopeForRun("routine", null, conversation)).toThrow("own context run ID");
    expect(contextScopeForRun("background_revival", null, conversation, first).scopeId).toBe(conversation);
  });

  test.each([
    ["user", "turn"], ["bootstrap", "turn"], ["agent", "agent"], ["group", "agent"], ["routine", "automation"],
    ["event", "event"], ["background_revival", "background-revival"], ["handoff_resume", "handoff-resume"], ["broadcast", "broadcast"],
  ] as const)("maps durable origin %s to Bot's active request source %s", (origin, source) => {
    expect(runtimeRequestSourceForOrigin(origin)).toBe(source);
  });

  test("does not reset summary counts for event taps or background-task completion", () => {
    for (const type of ["agent.message", "group.message", "routine.scheduled", "subagent.task", "subagent.resume"])
      expect(wakeResetsSelfSummaryCount(type)).toBe(true);
    for (const type of ["subagent.completed", "subagent.failed", "subagent.stopped", "subagent.cancelled", "timeline.event"])
      expect(wakeResetsSelfSummaryCount(type)).toBe(false);
  });

  test("puts turn notes in one reminder block ahead of the timestamped query", () => {
    const update = "[SAND_HIDDEN_PROMPT]<<SAND_AGENT_PROFILE_UPDATE:v1:fixture>>\n<agent_profile_update>\n</agent_profile_update>";
    const sections = "<instructions_update>\nchanged\n</instructions_update>";
    const query = "<timestamp>Monday, Oct 20, 2026, 9:00 AM (UTC)</timestamp>\n<user_query>\nhi\n</user_query>";
    expect(turnContentWithNotes({ origin: "user", runtimeProfile: "agent", appendReplyReminder: true, notes: [update, null, sections] }, query)).toBe([
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

describe("reaction context routing", () => {
  const hidden = '[SAND_HIDDEN_PROMPT][The user reacted 👍 to your message: "391".]';
  const wrapped = (content: string) => timestampUserTurn(content, {
    occurredAt: new Date("2026-11-10T14:00:00Z"), timeZone: "America/New_York",
  });

  test("reaction feedback keeps user priority but allows event-style silent completion", () => {
    expect(runtimeRequestSourceForOrigin("user", "user.reaction")).toBe("event");
    expect(runtimeRequestSourceForOrigin("user", "message.user")).toBe("turn");
    expect(runtimeRequestSourceForOrigin("bootstrap", "user.reaction")).toBe("turn");
  });

  test("a reaction wake gets no text-reply reminder, even when one is requested", () => {
    const content = wrapped(hidden);
    expect(turnContentWithNotes({ origin: "user", inboxType: "user.reaction", runtimeProfile: "agent", appendReplyReminder: true, notes: [] }, content)).toBe(content);
    // Older callers without inbox metadata still recognize the canonical hidden query.
    expect(turnContentWithNotes({ origin: "user", runtimeProfile: "agent", notes: [] }, content)).toBe(content);
  });

  test("visible user messages still require delivery, even when they quote a hidden marker", () => {
    const content = wrapped("[t1u]\n[SAND_HIDDEN_PROMPT] explain this marker");
    const turn = turnContentWithNotes({ origin: "user", inboxType: "message.user", runtimeProfile: "agent", appendReplyReminder: true, notes: [] }, content);
    expect(turn).toStartWith("<system_reminder>\n");
    expect(turn).toContain("SendToUser");
    expect(turn).toContain("Plain assistant text is NEVER delivered");
    expect(turn).toEndWith(content);
  });
});

describe("turn completion", () => {
  test("only completed turns succeed; stops are not failures; runtime messages are kept", () => {
    const completion = (status: string, error?: { message: string }) =>
      turnCompletionFailure({ type: "turn.completed", turnId: "run", status, ...(error ? { error } : {}) } as never);
    expect(completion("completed")).toBeNull();
    const interrupted = completion("interrupted");
    expect(interrupted?.message).toBe("Computer turn ended with status interrupted");
    expect(interrupted).not.toBeInstanceOf(TurnStoppedError);
    const cancelled = completion("cancelled");
    expect(cancelled).toBeInstanceOf(TurnStoppedError);
    expect(cancelled?.message).toBe("Computer turn ended with status cancelled");
    expect(completion("failed", { message: "OAuth module could not load" })?.message).toBe("OAuth module could not load");
  });
});

describe("memory recording exchange", () => {
  const occurredAt = new Date("2026-08-27T20:07:24.726Z");
  test("prefers clean visible messages and joins visible agent replies", () => {
    expect(resolveTurnMemoryExchange({
      visibleUser: { content: "  Remember cobalt headers.  ", createdAt: occurredAt },
      internalUser: { content: "<timestamp>wrapped</timestamp><user_query>[t190u] stale</user_query>", createdAt: new Date(0) },
      visibleAssistant: [{ content: " First update. " }, { content: "Final answer." }],
      internalAssistant: [{ content: "Checked the headers." }, { content: " " }],
    })).toEqual({ user: "Remember cobalt headers.", assistant: "First update.\nFinal answer.\nChecked the headers.", occurredAt: occurredAt.getTime() });
  });

  test("falls back to internal messages, still reviews reaction-only or silent turns, and needs a user side", () => {
    expect(resolveTurnMemoryExchange({
      visibleUser: null,
      internalUser: { content: "Internal request", createdAt: occurredAt },
      visibleAssistant: [],
      internalAssistant: [{ content: "Internal draft" }, { content: "Internal response" }],
    })).toEqual({ user: "Internal request", assistant: "Internal draft\nInternal response", occurredAt: occurredAt.getTime() });
    expect(resolveTurnMemoryExchange({ visibleUser: { content: "FYI I'm vegetarian now", createdAt: occurredAt }, internalUser: null, visibleAssistant: [], internalAssistant: [] }))
      .toEqual({ user: "FYI I'm vegetarian now", assistant: "", occurredAt: occurredAt.getTime() });
    expect(resolveTurnMemoryExchange({ visibleUser: null, internalUser: null, visibleAssistant: [{ content: "Hi" }], internalAssistant: [] })).toBeNull();
  });
});
