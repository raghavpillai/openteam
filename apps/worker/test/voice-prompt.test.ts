import { describe, expect, test } from "bun:test";
import { voiceTurnPrompt } from "../src/worker";

describe("voice worker prompt", () => {
  test("stays internal and directs visible output through SendToUser", () => {
    expect(voiceTurnPrompt).toContain("[SAND_HIDDEN_PROMPT]");
    expect(voiceTurnPrompt).toContain("SendToUser");
    expect(voiceTurnPrompt).not.toContain("```\n");
  });
});
