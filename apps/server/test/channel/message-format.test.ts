import { describe, expect, test } from "bun:test";
import { formatDirectMentionContext, formatUserPrompt } from "../../src/services/channel-service";

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
});
