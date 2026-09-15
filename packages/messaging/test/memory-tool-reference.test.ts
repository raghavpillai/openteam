import { expect, test } from "bun:test";
import fixture from "./fixtures/memory-tool-reference.json";
import { recallMemoryResult } from "../src/recall-memory";
import { renderMemoryConversationScopeStory, type MemoryScopeStory } from "../src/memory-scopes";

for (const [index, reference] of fixture.cases.entries()) {
  test(`RecallMemory matches installed Grok source: ${index}`, () => {
    expect(
      recallMemoryResult(
        reference.input,
        reference.candidates.map((fact) => ({
          content: fact.content,
          createdAt: new Date(fact.createdAt),
          tier: fact.kind,
          scope: fact.scope as "agent" | "user",
          via: fact.via,
          source:
            fact.source?.kind === "conversation"
              ? "this conversation"
              : fact.source?.kind === "sibling"
                ? `via session ${fact.source.sessionId}`
                : undefined,
        }))
      )
    ).toBe(reference.expected);
  });
}
for (const [index, reference] of fixture.stories.entries()) {
  test(`memory scope guidance matches installed Grok source: ${index}`, () => {
    expect(renderMemoryConversationScopeStory(reference.input as MemoryScopeStory)).toBe(
      reference.expected
    );
  });
}
