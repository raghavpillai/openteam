import { expect, test } from "bun:test";

test("chat anchors its absolute composer inside the keyboard-resized content", async () => {
  const source = await Bun.file(new URL("../app/chat/[channelId].tsx", import.meta.url)).text();
  expect(source).toMatch(
    /<KeyboardAvoidingView[\s\S]*?<View testID="chat-keyboard-content" style=\{styles\.flex\}>/
  );
  const content = source.slice(
    source.indexOf('testID="chat-keyboard-content"'),
    source.indexOf("</KeyboardAvoidingView>")
  );
  expect(content).toContain("styles.composerOverlay");
  expect(content).toContain("<Composer");
  expect(source).toContain('position: "absolute"');
});
