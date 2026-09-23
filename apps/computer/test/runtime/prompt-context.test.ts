import { expect, test } from "bun:test";
import {
  communicationReminder,
  enrichUserInfo,
  promptFingerprint,
  EARLY_RESULT_REMINDER,
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
  expect(communicationReminder(messages, active)?.kind).toBe("ack");
  expect(communicationReminder(messages, { ...active, requestSource: "automation" })).toBeNull();
  expect(communicationReminder(messages, { ...active, subagentType: "executor" })).toBeNull();
  expect(
    communicationReminder(
      [...messages, { role: "custom", customType: "openteam-communication-reminder" }],
      active
    )
  ).toBeNull();
});

test("opening acknowledgement is followed by a result reminder after work", () => {
  expect(communicationReminder([user, call("SendToUser", { type: "text" })], active)).toBeNull();
  expect(
    communicationReminder([user, call("SendToUser", { type: "text" }), call("Read")], active)
  ).toEqual({ kind: "early-result", content: EARLY_RESULT_REMINDER });
  expect(
    communicationReminder(
      [user, call("SendToUser", { type: "widget" }), call("Read"), call("Read")],
      active
    )?.kind
  ).toBe("ack");
});

test("early reminders allow unfinished work; prolonged silence requires an update", () => {
  const start = [user, call("SendToUser", { type: "text" }), call("Read")];
  const note = {
    role: "custom",
    customType: "openteam-communication-reminder",
    content: EARLY_RESULT_REMINDER,
  };
  expect(communicationReminder([...start, note, call("Read")], active)).toBeNull();
  expect(
    communicationReminder(
      [...start, note, ...Array.from({ length: 6 }, () => call("Read"))],
      active
    )
  ).toEqual({ kind: "progress", content: PROGRESS_REMINDER });
  expect(
    communicationReminder(
      [...start, note, call("SendToUser", { type: "text" }), call("Read")],
      active
    )?.kind
  ).toBe("early-result");
});

test("injected user-role notes do not hide a long silent streak or a newer real user turn", () => {
  const note = {
    role: "user",
    content: EARLY_RESULT_REMINDER,
    providerOptions: { cursor: { sandEarlyResultReminder: true } },
  };
  const start = [user, call("SendToUser", { type: "text" }), call("Read"), note];
  expect(
    communicationReminder([...start, ...Array.from({ length: 6 }, () => call("Read"))], active)
      ?.kind
  ).toBe("progress");
  expect(communicationReminder([...start, user, call("Read"), call("Read")], active)?.kind).toBe(
    "ack"
  );
});
