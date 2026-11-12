import { describe, expect, test } from "bun:test";
import {
  formatChannelRenamePrompt,
  formatDirectMentionContext,
  formatUserPrompt,
  formatUserReactionPrompt,
} from "../../src/services/channel-service";

describe("channel message interaction prompts", () => {
  test("adds only directly mentioned peers to the model-facing roster context", () => {
    expect(
      formatDirectMentionContext("Ask @ParityProbev3 to check", [
        { id: "peer-1", name: "Parity Probe v3" },
        { id: "peer-2", name: "Research Bot" },
      ])
    ).toBe(
      "[Agents mentioned in this message — you can reach them with SendToAgent using their id:]\n" +
        "- Parity Probe v3 (id: peer-1)\n\n" +
        "Ask @ParityProbev3 to check"
    );
    expect(
      formatDirectMentionContext("This is for the current bot", [
        { id: "peer-1", name: "Parity Probe v3" },
      ])
    ).toBe("This is for the current bot");
  });

  test("quotes the replied-to message after the new user address", () => {
    expect(
      formatUserPrompt("t18u", "What user prompt do you see?", {
        id: "message-17",
        sequence: 17n,
        sender: "agent",
        content: "Test 2 received.",
        metadata: { address: "t17s0" },
      })
    ).toBe('[t18u]\n[In reply to t17s0: "Test 2 received."]\nWhat user prompt do you see?');
  });

  test("caps the reaction wake quote at OpenTeam's 80-character limit", () => {
    const prompt = formatUserReactionPrompt("👍", "x".repeat(120));
    expect(prompt).toContain(`${JSON.stringify(`${"x".repeat(79)}…`)}`);
    expect(prompt).not.toContain("x".repeat(80));
  });

  test.each(["👎", "👎🏽", "👎️"])("treats %s as feedback needing a delivered correction or clarification", (emoji) => {
    const prompt = formatUserReactionPrompt(emoji, "17 × 23 = 391");
    expect(prompt).toContain("The user reacted " + emoji);
    expect(prompt).toContain(JSON.stringify("17 × 23 = 391"));
    expect(prompt).toContain("Re-check it");
    expect(prompt).toContain("correction");
    expect(prompt).toContain("what the user wants changed");
    expect(prompt).toContain("Deliver your response with SendToUser");
    expect(prompt).not.toContain("You don't need to reply");
  });

  test("formats a rename as one hidden user-role wake with profile and event layers", () => {
    const prompt = formatChannelRenamePrompt({ name: "a2a", description: "" });
    const token = prompt.match(/SAND_AGENT_PROFILE_UPDATE:v1:([^>]+)>>/)?.[1];

    expect(token && Buffer.from(token, "base64").toString("utf8")).toBe(
      '{"name":"a2a","description":""}'
    );
    expect(prompt).toContain("<agent_profile_update>");
    expect(prompt).toContain("Current name: a2a");
    expect(prompt).toContain("Current description: (no description)");
    expect(prompt).toContain("[event] Something about this conversation just changed.");
    expect(prompt).toContain("- Renamed to a2a");
  });
});
