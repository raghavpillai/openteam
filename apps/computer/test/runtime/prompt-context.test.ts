import { expect, test } from "bun:test";
import {
  communicationReminder,
  enrichUserInfo,
  promptFingerprint,
  ACK_REMINDER,
  PROGRESS_REMINDER,
} from "../../src/runtime/prompt-context";

const user = { role: "user", content: "do work" };
const call = (name: string, args = {}) => ({
  role: "assistant",
  content: [{ type: "toolCall", name, arguments: args }],
});
const active = { requestSource: "turn", subagentType: null } as const;

test("runtime context describes actual tools and preserves saved skill catalog", () => {
  const text = enrichUserInfo(
    "<user_info>\n<agent_skills>test skill</agent_skills>\n</user_info>",
    {
      cwd: "/workspace/task",
      transcriptPath: "/private/session.jsonl",
      namespaces: [{ name: "test", description: "test namespace", tools: [{ name: "Lookup" }] }],
    }
  );
  expect(text).toContain("Workspace Path: /workspace/task");
  expect(text).toContain("test skill");
  expect(text).toContain("<available_subagent_types>");
  expect(text).toContain("Tools: Lookup");
  expect(promptFingerprint("system", text, [], 2)).toEqual(
    promptFingerprint("system", text, [], 2)
  );
  expect(promptFingerprint("system", text, ["Lookup"], 2).toolsSha).not.toBe(
    promptFingerprint("system", text, [], 2).toolsSha
  );
});

test("acknowledgement reminders fire during work, with silent/worker exclusions", () => {
  const messages = [user, call("Read"), call("Shell")];
  expect(communicationReminder([user, call("Read")], active)).toBeNull();
  expect(communicationReminder(messages, active)).toEqual({ kind: "ack", content: ACK_REMINDER });
  expect(communicationReminder(messages, { ...active, requestSource: "automation" })).toBeNull();
  expect(communicationReminder(messages, { ...active, subagentType: "executor" })).toBeNull();
  expect(
    communicationReminder(
      [...messages, { role: "custom", customType: "openteam-communication-reminder" }],
      active
    )
  ).toBeNull();
});

const reminderNote = (content: string) => ({ role: "custom", customType: "openteam-communication-reminder", content });
/** Runs the hook before each step the way the context hook does, appending what it injects. */
const simulate = (steps: Array<ReturnType<typeof call>>) => {
  const messages: any[] = [user];
  const fired: Array<{ before: number; kind: string }> = [];
  steps.forEach((step, index) => {
    const reminder = communicationReminder(messages, active);
    if (reminder) {
      fired.push({ before: index + 1, kind: reminder.kind });
      messages.push(reminderNote(reminder.content));
    }
    messages.push(step, { role: "toolResult", toolCallId: `call-${index}`, content: [] });
  });
  return fired;
};

test("the ack repeats every two silent calls until the user hears from the bot", () => {
  expect(simulate(Array.from({ length: 13 }, () => call("Shell")))).toEqual(
    [3, 5, 7, 9, 11, 13].map((before) => ({ before, kind: "ack" }))
  );
});

test("after an ack the progress reminder fires once per seven silent calls, not every step", () => {
  expect(simulate([call("SendToUser", { type: "text" }), ...Array.from({ length: 16 }, () => call("Shell"))])).toEqual([
    { before: 9, kind: "progress" },
    { before: 16, kind: "progress" },
  ]);
});

test("a reaction that went through acknowledges the user; a widget or failed reaction does not", () => {
  const react = { role: "assistant", content: [{ type: "toolCall", id: "r", name: "ReactToMessage", arguments: { emoji: "👍" } }] };
  const reacted = (isError: boolean) => [user, react, { role: "toolResult", toolCallId: "r", isError, content: [] }, call("Shell"), call("Shell")];
  expect(communicationReminder(reacted(false), active)).toBeNull();
  expect(communicationReminder(reacted(true), active)?.kind).toBe("ack");
  expect(communicationReminder([user, call("SendToUser", { type: "widget" }), call("Read"), call("Read")], active)?.kind).toBe("ack");
  expect(communicationReminder([user, call("SendToUser", { type: "widget" }), call("Read")], active)).toBeNull();
});

test("a newer real user message starts a new acknowledgement window", () => {
  expect(communicationReminder([user, call("SendToUser", { type: "text" }), call("Read"), user, call("Read"), call("Read")], active)?.kind).toBe("ack");
  // Injected reminder blocks are skipped when looking back for the ack.
  const hold = { role: "custom", customType: "openteam-end-turn-hold", content: "<system_reminder>\nYour turn did not end.\n</system_reminder>" };
  expect(communicationReminder([user, call("SendToUser", { type: "text" }), hold, call("Read"), call("Read")], active)).toBeNull();
});

test("a reply cut off at the output limit gets one reminder to continue in smaller pieces", async () => {
  const { OUTPUT_LIMIT_REMINDER, owesOutputLimitReminder } = await import("../../src/runtime/prompt-context");
  const cut = { role: "assistant", content: [{ type: "text", text: "Part one" }], stopReason: "length" };
  expect(owesOutputLimitReminder([user, cut, { role: "toolResult", toolCallId: "x" }], {})).toBe(true);
  expect(owesOutputLimitReminder([user, cut], { outputLimitReminded: true })).toBe(false);
  expect(owesOutputLimitReminder([user, { ...cut, stopReason: "stop" }], {})).toBe(false);
  const { ComputerRuntime } = await import("../../src/runtime");
  const runtime = new ComputerRuntime() as any;
  runtime.compaction = { beginUserQuery: async () => {}, settleAtTurnEnd: async () => null, parkBackground() {} };
  runtime.cleanup = async () => {};
  const prompts: string[] = [];
  const messages: any[] = [];
  const active = {
    subagentType: "executor", requestSource: "subagent", turnId: "t", runId: "r", contextSessionId: "c",
    attachmentTempDirectories: [], sentMessageCount: 0,
    session: {
      messages,
      prompt: async (text: string) => { prompts.push(text); messages.push(user, prompts.length === 1 ? cut : { ...cut, stopReason: "length" }); },
      getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [],
    },
    queue: { push() {}, end() {} },
  } as any;
  await runtime.execute(active, "Write the report.", []);
  expect(prompts).toEqual(["Write the report.", OUTPUT_LIMIT_REMINDER]);
  expect(OUTPUT_LIMIT_REMINDER).toBe("<system_reminder>Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.</system_reminder>");
});
