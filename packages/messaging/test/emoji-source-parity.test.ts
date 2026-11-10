import { expect, test } from "bun:test";
import { REACT_TO_MESSAGE_TOOL } from "@openteam/contracts";
import { DELEGATING_SECTION, PLATFORM_BASE_SYSTEM_PROMPT } from "../src/platform-system-prompt";
import { USER_REPLY_REMINDER } from "../src/turn-notes";
import captured from "./fixtures/grok-emoji-guidance-2026-11-02.json";

// Independently extracted from the captured bundle, with source hash and locations.
// These checks establish text equality to that capture, not authentication of live prompts.
test("the entire effective reaction description and schema match the captured active variant", () => {
  expect(REACT_TO_MESSAGE_TOOL.description).toBe(captured.activeDescription);
  expect(REACT_TO_MESSAGE_TOOL.inputSchema).toEqual(captured.reactionSchema);
});

test("reply reminder and emoji-relevant turn clauses retain source wording", () => {
  expect(USER_REPLY_REMINDER).toBe(captured.replyReminder);
  expect(PLATFORM_BASE_SYSTEM_PROMPT).toContain(captured.reactionClause);
  expect(PLATFORM_BASE_SYSTEM_PROMPT).toContain(captured.hiddenWakeClause);
  expect(PLATFORM_BASE_SYSTEM_PROMPT).toContain(captured.inlineEmojiClause);
  expect(DELEGATING_SECTION.split("\n")).toContain(captured.delegationAcknowledgement);
});

test("the source-backed version contains none of our experimental behavioral additions", () => {
  const text = [REACT_TO_MESSAGE_TOOL.description, USER_REPLY_REMINDER, PLATFORM_BASE_SYSTEM_PROMPT].join("\n");
  for (const addition of ["A brief instruction update", "prefer a reaction if words add nothing", "Acknowledge a request once", "such as thanks or agreement"])
    expect(text).not.toContain(addition);
});
