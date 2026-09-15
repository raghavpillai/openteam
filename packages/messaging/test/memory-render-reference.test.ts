import { expect, test } from "bun:test";
import fixture from "./fixtures/memory-render-reference.json";
import {
  renderMemorySystemPrompt,
  renderUserMemorySystemPrompt,
  renderProjectMemorySystemPrompt,
  selectProjectMemoryBlocks,
  type PromptMemoryRecall,
  type ProjectMemoryBlock,
} from "../src/memory-rendering";
import type { MemoryScopeStory } from "../src/memory-scopes";
for (const [index, reference] of fixture.cases.entries()) {
  test(`memory prompt matches reference budgets and provenance: ${index}`, () => {
    const recall = reference.recall as PromptMemoryRecall;
    const opts = reference.opts as { conversationMemory: MemoryScopeStory } | undefined;
    expect(renderMemorySystemPrompt(recall, reference.location, opts)).toBe(reference.own);
    expect(renderUserMemorySystemPrompt(recall, reference.userCtx)).toBe(reference.user);
    const selected = selectProjectMemoryBlocks(reference.blocks as ProjectMemoryBlock[], 3);
    expect(selected).toEqual(reference.selected as typeof selected);
    expect(
      renderProjectMemorySystemPrompt(selected, { projectsRootDir: "/sand-data/projects" })
    ).toBe(reference.project);
  });
}
