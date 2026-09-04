import { expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

test("iOS message motion preserves Grokbot entrance and acknowledgement semantics", async () => {
  const [bubble, route, context, theme, themeTokens, deliveryPolicy] = await Promise.all([
    source("src/components/message-bubble.tsx"),
    source("app/chat/[channelId].tsx"),
    source("src/state/openteam-context.tsx"),
    source("src/theme.ts"),
    Bun.file(
      new URL("../../../packages/design-tokens/src/mobile-theme.ts", import.meta.url)
    ).text(),
    Bun.file(
      new URL("../../../packages/product-core/src/durable-delivery.ts", import.meta.url)
    ).text(),
  ]);

  expect(bubble).toContain("Easing.bezier(0.23, 1, 0.32, 1)");
  expect(bubble).toContain("duration: 240");
  expect(bubble).toContain("duration: 132");
  expect(bubble).toContain("pending ? 0.55 : 1");
  expect(bubble).toContain('transformOrigin: isUser ? "100% 100%" : "0% 100%"');
  expect(route).toContain(
    "keyExtractor={(entry) => (isA2AActivity(entry) ? entry.id : messageRenderKey(entry))}"
  );
  expect(route).toContain("knownMessageKeys.current = new Set(mainMessages.map(messageRenderKey))");
  expect(route).not.toContain("knownMessageKeys.current.add");
  expect(context).toContain("createDurableSendController");
  expect(context).toContain("projectOutgoingMessages(snapshot.channelMessages, durableSends");
  expect(context).toContain('echoRenderKey: "delivery"');
  expect(context).toContain('orderBy: "messageId"');
  expect(context).toContain("delivery.nonce");
  expect(context).toContain("clientId: record.nonce");
  expect(context).toContain("await sendController.enqueue");
  expect(context).toContain("sendController.reconcile");
  expect(route).toContain('deliveryState === "pending" || deliveryState === "queued"');
  expect(route).toContain("onResendFailed");
  expect(route).toContain("onDeleteFailed");
  expect(route).toContain("onCancelQueued");
  expect(bubble).toContain('durableSendStatusLabel("failed")');
  expect(bubble).toContain('durableSendStatusLabel("queued", deliveryTransportDown)');
  expect(deliveryPolicy).toContain('return transportDown ? "Will send when reconnected"');
  expect(deliveryPolicy).toContain('if (phase === "failed") return "Failed to send"');
  expect(bubble).toContain('accessibilityLabel="Failed message actions"');
  expect(bubble).not.toContain("failedHighlight");
  expect(bubble).not.toContain("rgba(255,192,0");
  expect(bubble).toContain("sentOfflineVisibility");
  expect(bubble).toContain('messageWrap: { maxWidth: "89%", marginVertical: 3 }');
  expect(bubble).toContain(
    "bubble: { borderRadius: 21, paddingHorizontal: 15, paddingVertical: 10 }"
  );
  expect(bubble).toContain("content: { fontSize: 16, lineHeight: 22, letterSpacing: -0.15 }");
  expect(route).toContain("paddingHorizontal: 14");
  expect(theme).toContain('from "@openteam/design-tokens/mobile-theme"');
  expect(themeTokens).toContain('userBubble: "#0A0A0A"');
  expect(themeTokens).toContain('assistantBubble: "#F1F1EF"');
});

test("right-swiping a message reveals the native thread affordance and opens its thread", async () => {
  const [bubble, route, thread, composer] = await Promise.all([
    source("src/components/message-bubble.tsx"),
    source("app/chat/[channelId].tsx"),
    source("src/components/thread-sheet.tsx"),
    source("src/components/composer.tsx"),
  ]);

  expect(bubble).toContain("PanResponder.create");
  expect(bubble).toContain("onMoveShouldSetPanResponderCapture");
  expect(bubble).toContain("gesture.dx >= 52");
  expect(bubble).toContain("swipeThreadIndicator");
  expect(bubble).toContain("if (finished) onStartThread()");
  expect(route).toContain("onStartThread={() => setThreadRootId(item.id)}");
  expect(thread).toContain('presentationStyle="fullScreen"');
  expect(thread).toContain('name="chevron.left"');
  expect(thread).toContain("threadTimestamp(thread.root.createdAt)");
  expect(thread).toContain("placeholder={`Reply ${botName}`}");
  expect(thread).not.toContain(">Replies<");
  expect(composer).toContain("const inputPlaceholder = placeholder ?? `Message ${botName}`");
});
