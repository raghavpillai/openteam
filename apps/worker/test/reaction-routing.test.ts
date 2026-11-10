import { expect, test } from "bun:test";
import { timestampUserTurn } from "@openteam/messaging";
import { runtimeRequestSourceForOrigin, turnContentWithNotes } from "../src/worker";

const hidden = '[SAND_HIDDEN_PROMPT][The user reacted 👍 to your message: "391".]';
const wrapped = (content: string) => timestampUserTurn(content, {
  occurredAt: new Date("2026-11-10T14:00:00Z"), timeZone: "America/New_York",
});

test("reaction feedback keeps user priority but allows event-style silent completion", () => {
  expect(runtimeRequestSourceForOrigin("user", "user.reaction")).toBe("event");
  expect(runtimeRequestSourceForOrigin("user", "message.user")).toBe("turn");
  expect(runtimeRequestSourceForOrigin("bootstrap", "user.reaction")).toBe("turn");
});

test("a reaction wake gets no text-reply reminder after canonical timestamp framing", () => {
  const content = wrapped(hidden);
  expect(turnContentWithNotes({ origin: "user", inboxType: "user.reaction", runtimeProfile: "agent", notes: [] }, content)).toBe(content);
  // Older callers without inbox metadata still recognize the canonical hidden query.
  expect(turnContentWithNotes({ origin: "user", runtimeProfile: "agent", notes: [] }, content)).toBe(content);
});

test("visible user messages still require delivery, even when they quote a hidden marker", () => {
  const content = wrapped("[t1u]\n[SAND_HIDDEN_PROMPT] explain this marker");
  const turn = turnContentWithNotes({ origin: "user", inboxType: "message.user", runtimeProfile: "agent", notes: [] }, content);
  expect(turn).toStartWith("<system_reminder>\n");
  expect(turn).toContain("SendToUser");
  expect(turn).toContain("ReactToMessage");
  expect(turn).toEndWith(content);
});

test("hidden feedback retains meaningful instruction updates without demanding a reply", () => {
  const content = wrapped(hidden), note = "<instructions_update>new preference</instructions_update>";
  expect(turnContentWithNotes({ origin: "user", inboxType: "user.reaction", runtimeProfile: "agent", notes: [note] }, content))
    .toBe(`<system_reminder>\n${note}\n</system_reminder>\n${content}`);
});
