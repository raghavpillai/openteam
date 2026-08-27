import { describe, expect, test } from "bun:test";
import { MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS } from "../src/index";

describe("main-agent graphical delegation instructions", () => {
  test("routes browser and desktop work to their specialized subagents", () => {
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain("subagent_type browserUse");
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain("subagent_type computerUse");
    expect(MAIN_AGENT_GRAPHICAL_DELEGATION_INSTRUCTIONS).toContain(
      "Do not attempt graphical interaction yourself"
    );
  });
});
