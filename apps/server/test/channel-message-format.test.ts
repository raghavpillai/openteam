import { describe, expect, test } from "bun:test";
import { formatUserPrompt, formatUserReactionPrompt } from "../src/services/channel-service";

describe("channel message interaction prompts", () => {
  test("formats an image-only user prompt without trailing whitespace", () => {
    expect(formatUserPrompt(19n, "")).toBe("[t19u]");
  });

  test("quotes the replied-to message after the new user address", () => {
    expect(
      formatUserPrompt(18n, "What user prompt do you see?", {
        id: "message-17",
        sequence: 17n,
        sender: "agent",
        content: "Test 2 received.",
        metadata: { address: "t17s0" },
      })
    ).toBe('[t18u]\n[In reply to t17s0: "Test 2 received."]\nWhat user prompt do you see?');
  });

  test("uses the hidden reaction wrapper delivered to the authoring agent", () => {
    expect(formatUserReactionPrompt("❤️", "Nothing in the transcripts looks inbound.")).toBe(
      "[SAND_HIDDEN_PROMPT][The user reacted ❤️ to your message: \"Nothing in the transcripts looks inbound.\". You don't need to reply; act on it only if it's useful (e.g. acknowledge, adjust, or continue).][SAND_HIDDEN_PROMPT]"
    );
  });
});
