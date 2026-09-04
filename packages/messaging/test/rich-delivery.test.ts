import { describe, expect, test } from "bun:test";
import {
  buildChannelDeliveryFailureWakePrompt,
  buildDismissedQuestionsNote,
  validateSendToUserInput,
} from "../src";

describe("OpenTeam-compatible rich delivery", () => {
  test("keeps the source-verified channel failure and widget dismissal prompts exact", () => {
    expect(
      buildChannelDeliveryFailureWakePrompt({ channel: "slack:C123", error: "not connected" })
    ).toBe(`[channel-delivery-failed] A message you tried to send to a channel did not go through.
This is a system notice about your own outbound send, not the user typing in this app. You may have already told the user it was sent, so correct the record.
- To slack:C123: not connected
Tell the user plainly here, in this in-app chat (a SendToUser with no channel target), that the message didn't go through and why, so they aren't left believing it was delivered. Don't silently retry the same channel; if it isn't connected, offer to help connect it.`);
    expect(buildDismissedQuestionsNote(["Which region?"])).toBe(
      `The user dismissed your question ("Which region?") without answering — they'd rather not respond. Don't ask it again or wait for an answer; continue with what you already know and decide yourself.`
    );
    expect(buildDismissedQuestionsNote(["Which region?", "Deploy now?"])).toBe(
      `The user dismissed these questions without answering — they'd rather not respond:
- "Which region?"
- "Deploy now?"
Don't ask them again or wait for answers; continue with what you already know and decide yourself.`
    );
  });

  test("removes cursor-agent and rejects fields from another delivery branch", () => {
    expect(() => validateSendToUserInput({ type: "cursor-agent", bcId: "cloud-1" })).toThrow();
    expect(() =>
      validateSendToUserInput({
        type: "widget",
        widget: { prompt: "Continue?", options: [{ label: "Yes" }] },
        channel: "slack:C123",
      })
    ).toThrow();
    expect(() =>
      validateSendToUserInput({ type: "text", content: "Done", channel: "slack:C123" })
    ).not.toThrow();
    expect(() => validateSendToUserInput({ type: "text" })).toThrow();
    expect(() => validateSendToUserInput({ type: "attachment", url: "" })).toThrow();
    expect(() => validateSendToUserInput({ type: "widget", widget: {} })).toThrow();
    expect(() =>
      validateSendToUserInput({
        type: "secret-request",
        secret: { label: "Token", connector: "slack" },
      })
    ).toThrow();
  });
});
