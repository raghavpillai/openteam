import { describe, expect, mock, test } from "bun:test";
import { DraftHydrationGuard } from "../src/draft-hydration";

mock.module("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
  getInfoAsync: async () => ({ exists: false }),
  readAsStringAsync: async () => "",
  writeAsStringAsync: async () => undefined,
  makeDirectoryAsync: async () => undefined,
  moveAsync: async () => undefined,
  deleteAsync: async () => undefined,
}));

const { conversationDraftKey } = await import("../src/drafts");

describe("mobile draft lifecycle", () => {
  test("isolates identical channel IDs by normalized server origin", () => {
    const first = conversationDraftKey("https://first.openbot.test/path/", "shared-channel");
    const sameOrigin = conversationDraftKey("https://first.openbot.test/other", "shared-channel");
    const second = conversationDraftKey("https://second.openbot.test", "shared-channel");

    expect(first).toBe(sameOrigin);
    expect(first).not.toBe(second);
    expect(
      conversationDraftKey("https://first.openbot.test", "shared-channel", "account-a")
    ).not.toBe(conversationDraftKey("https://first.openbot.test", "shared-channel", "account-b"));
    expect(conversationDraftKey("", "fixture-channel")).toBe("fixture-channel");
  });

  test("a delayed draft load cannot overwrite text edited while it was pending", async () => {
    const guard = new DraftHydrationGuard();
    const checkpoint = guard.checkpoint();
    let text = "";
    let attachments: string[] = [];
    let finishLoad = (_draft: { text: string; attachments: string[] }) => undefined;
    const load = new Promise<{ text: string; attachments: string[] }>((resolve) => {
      finishLoad = resolve;
    }).then((draft) => {
      if (guard.isUntouched(checkpoint, "text")) text = draft.text;
      if (guard.isUntouched(checkpoint, "attachments")) attachments = draft.attachments;
    });

    guard.markEdited("text");
    text = "typed before keychain read finished";
    finishLoad({ text: "stale saved text", attachments: ["saved-asset"] });
    await load;

    expect(text).toBe("typed before keychain read finished");
    expect(attachments).toEqual(["saved-asset"]);

    const composerSource = await Bun.file(
      new URL("../src/components/composer.tsx", import.meta.url)
    ).text();
    expect(composerSource).toContain("loadConversationDraft(draftKey)");
    expect(composerSource).toContain('isUntouched(hydrationCheckpoint, "text")');
  });
});
