import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("Grok-compatible composer while a Bot is working", () => {
  test("keeps send available and does not expose a composer stop button", async () => {
    const [promptInput, chatPane, mentionEditor] = await Promise.all([
      source("../src/renderer/components/ai-elements/prompt-input.tsx"),
      source("../src/renderer/components/openbot/chat-pane.tsx"),
      source("../src/renderer/components/openbot/mention-editor.tsx"),
    ]);

    expect(promptInput).toContain("const blocked = Boolean(disabled || submitting || staging)");
    expect(promptInput).toContain("disabled={Boolean(disabled)}");
    expect(mentionEditor).toContain("const keepCaret = document.activeElement === editor");
    expect(mentionEditor).toContain("editor.focus({ preventScroll: true })");
    expect(promptInput).not.toContain('aria-label="Stop run"');
    expect(chatPane).not.toContain("onStop={activeRun");
    expect(chatPane).not.toContain("running={Boolean(activeRun)}");
  });
});
