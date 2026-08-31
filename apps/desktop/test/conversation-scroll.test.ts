import { describe, expect, test } from "bun:test";

const conversationSource = () =>
  Bun.file(
    new URL("../src/renderer/components/ai-elements/conversation.tsx", import.meta.url)
  ).text();
const stylesSource = () => Bun.file(new URL("../src/renderer/styles.css", import.meta.url)).text();
const chatPaneSource = () =>
  Bun.file(new URL("../src/renderer/components/openbot/chat-pane.tsx", import.meta.url)).text();

describe("conversation scrolling", () => {
  test("snaps initial, new-message, resized, and requested positions instantly", async () => {
    const [source, styles] = await Promise.all([conversationSource(), stylesSource()]);

    expect(source).toContain('initial="instant"');
    expect(source).toContain('resize="instant"');
    expect(source).toContain('scrollToBottom("instant")');
    expect(source).toContain("viewport.scrollTop = viewport.scrollHeight");
    expect(source).toContain("queueMicrotask(snap)");
    expect(source).toContain("window.requestAnimationFrame(snap)");
    expect(source).toContain("hasNewTailContent && previous.wasAtBottom && viewport");
    expect(source).toContain("wasAtBottom: isAtBottom");
    expect(source).toContain("showTail && !previous.showTail");
    expect(source).toContain('scrollClassName={cn("conversation-scroll", scrollClassName)}');
    expect(styles).toMatch(/\.conversation-scroll\s*\{\s*scrollbar-gutter: auto !important;/);
  });

  test("keeps the transcript full-height behind a measured composer dock", async () => {
    const source = await chatPaneSource();

    expect(source).toContain('data-composer-dock=""');
    expect(source).toContain('className="pointer-events-none absolute inset-x-0 bottom-0 z-[3]"');
    expect(source).toContain(
      "const transcriptBottomInset = composerVisible ? composerHeight + 24 : 4;"
    );
    expect(source).toContain("style={{ paddingBottom: transcriptBottomInset }}");
    expect(source).toContain("new ResizeObserver(update)");
    expect(source).toContain("bottomInset={composerVisible ? composerHeight + 8 : 8}");
    expect(source).not.toContain("<ConversationViewportAnchor");
  });

  test("keeps a fixed working slot at the end of the transcript", async () => {
    const source = await chatPaneSource();

    expect(source).toContain('type: "thinking" as const');
    expect(source).toContain('id: "thinking-slot"');
    expect(source).toContain("phase: thinkingPhase");
    expect(source).toContain("renderedTimeline.map((entry, index)");
    expect(source).toContain('data-timeline-entry="thinking"');
    expect(source).toContain('data-bot-thinking-slot=""');
    expect(source).toContain('className="flex h-9 shrink-0 items-center"');
    expect(source).toContain('className="bot-thinking-badge"');
    expect(source).toContain('className="bot-thinking-dot"');
    expect(source).toContain("const THINKING_EXIT_MS = 140;");
    expect(source).toContain("appendThinkingIndicatorToGroup(");
    expect(source).toContain('entry.type === "thinking"');
    expect(source).toContain("showTail={thinkingMounted}");
  });

  test("matches Grok's working badge geometry and presence motion", async () => {
    const styles = await stylesSource();

    expect(styles).toContain("width: 43px;");
    expect(styles).toContain("height: 28px;");
    expect(styles).toContain("gap: 3.5px;");
    expect(styles).toContain("width: 5.25px;");
    expect(styles).toContain("height: 5.25px;");
    expect(styles).toContain(
      "animation: bot-thinking-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) backwards;"
    );
    expect(styles).toContain("animation: bot-thinking-exit 140ms ease forwards;");
    expect(styles).toContain("animation: bot-thinking-dot 1.4s ease-in-out infinite;");
    expect(styles).toContain("animation-delay: -1.2s;");
    expect(styles).toContain("animation-delay: -1s;");
    expect(styles).toContain(".bot-thinking-content:hover .bot-thinking-label");
  });
});
