import { describe, expect, test } from "bun:test";
import {
  buildChannelDeliveryFailureWakePrompt,
  buildDismissedQuestionsNote,
  buildUnansweredQuestionNote,
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
      `The user dismissed your question ("Which region?") without answering. They'd rather not respond. Don't ask it again or wait for an answer; continue with what you already know and decide yourself.`
    );
    expect(buildDismissedQuestionsNote(["Which region?", "Deploy now?"])).toBe(
      `The user dismissed these questions without answering. They'd rather not respond:
- "Which region?"
- "Deploy now?"
Don't ask them again or wait for answers; continue with what you already know and decide yourself.`
    );
  });

  test("treats an unanswered question as skipped once the conversation moves on", () => {
    expect(buildUnansweredQuestionNote("Which region?", true)).toBe(
      `You asked the user a question ("Which region?") and they replied in chat instead of answering on the card. Their message below may be the answer or may be about something else; decide from what they wrote. If it answers the question, act on it without asking again. If not, treat the question as skipped: continue with what you already know, and only ask again if you still genuinely need it.`
    );
    expect(buildUnansweredQuestionNote("Want me to watch for a reply?", false)).toBe(
      `You asked the user ("Want me to watch for a reply?") and they haven't answered yet. This turn didn't come from them, and no answer is not a yes: don't do what you asked about unless they already allowed it or their memory or routines do. The card has closed. Don't put the question on a new card; if it still matters, say in your update that it's waiting on them, and they can answer in chat.`
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
