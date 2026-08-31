import { expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

test("iOS message motion preserves Grokbot entrance and acknowledgement semantics", async () => {
  const [bubble, route, context, theme] = await Promise.all([
    source("src/components/message-bubble.tsx"),
    source("app/chat/[channelId].tsx"),
    source("src/state/openbot-context.tsx"),
    source("src/theme.ts"),
  ]);

  expect(bubble).toContain("Easing.bezier(0.23, 1, 0.32, 1)");
  expect(bubble).toContain("duration: 240");
  expect(bubble).toContain("duration: 132");
  expect(bubble).toContain("pending ? 0.55 : 1");
  expect(bubble).toContain('transformOrigin: isUser ? "100% 100%" : "0% 100%"');
  expect(route).toContain("keyExtractor={messageRenderKey}");
  expect(route).toContain("knownMessageKeys.current = new Set(messages.map(messageRenderKey))");
  expect(route).not.toContain("knownMessageKeys.current.add");
  expect(context).toContain("renderKey: outgoing.localId");
  expect(context).toContain("serverMessageId: accepted.message.id");
  expect(bubble).toContain('messageWrap: { maxWidth: "88%", marginVertical: 3 }');
  expect(bubble).toContain(
    "bubble: { borderRadius: 21, paddingHorizontal: 15, paddingVertical: 10 }"
  );
  expect(bubble).toContain("content: { fontSize: 16, lineHeight: 22, letterSpacing: -0.15 }");
  expect(route).toContain("paddingHorizontal: 16");
  expect(theme).toContain('userBubble: "#0A0A0A"');
  expect(theme).toContain('assistantBubble: "#F1F1EF"');
});
