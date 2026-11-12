import { expect, test } from "bun:test";
import {
  parentOnlyDispatchNotice,
} from "../src/subagent-dispatch";

const PROMPT =
  "Research the flights, then UpdateMemory with the preference, SendToUser the summary, call DraftExternalMessage for the email, and UpdateRoutine to check daily. Use WebSearch and TodoWrite. Also SendToAgent the result.";

test("a dispatch naming tools the executor lacks tells the parent to do those steps itself", () => {
  expect(parentOnlyDispatchNotice({ subagentType: "executor", prompt: PROMPT })).toBe(
    [
      "<system_reminder>",
      "This dispatch names DraftExternalMessage, SendToAgent, SendToUser, TodoWrite, UpdateMemory, UpdateRoutine, which the executor subagent does not have, so it cannot do those steps.",
      "- DraftExternalMessage: Only the parent talks to the user; a Task subagent reports back in its final message.",
      "- SendToAgent: Messages under the user's name need approval that only the parent can collect.",
      "- SendToUser: Only the parent talks to the user; a Task subagent reports back in its final message.",
      "- TodoWrite: Task subagents don't start subagents of their own; the parent fans work out.",
      "- UpdateMemory: Memory, routines, tasks, and the bot's profile change only through the parent, which owns the conversation.",
      "- UpdateRoutine: Memory, routines, tasks, and the bot's profile change only through the parent, which owns the conversation.",
      "If the task needs them, do those steps yourself in this turn, before you end it. The subagent still runs and reports back on the rest.",
      "</system_reminder>",
    ].join("\n")
  );
});
