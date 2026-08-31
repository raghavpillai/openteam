import { expect, test } from "bun:test";

const rendererSource = (path: string) =>
  Bun.file(new URL(`../src/renderer/${path}`, import.meta.url)).text();

test("message entrance and acknowledgement motion match Grokbot", async () => {
  const [styles, chatPane, message] = await Promise.all([
    rendererSource("styles.css"),
    rendererSource("components/openbot/chat-pane.tsx"),
    rendererSource("components/ai-elements/message.tsx"),
  ]);

  expect(styles).toMatch(
    /@keyframes message-row-enter\s*\{\s*0%\s*\{\s*opacity: 0;\s*transform: translateY\(12px\) scale\(0\.94\);\s*\}\s*55%\s*\{\s*opacity: 1;\s*\}\s*100%\s*\{\s*opacity: 1;\s*transform: translateY\(0\) scale\(1\);/,
  );
  expect(styles).toContain("animation-duration: 1000ms;");
  expect(styles).toContain("animation-fill-mode: backwards;");
  expect(styles).toContain("animation-name: message-row-enter;");
  expect(styles).toContain(
    "animation-timing-function: cubic-bezier(0.23, 1, 0.32, 1);",
  );
  expect(styles).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 120ms;[\s\S]*animation-name: message-row-enter-reduced;/,
  );
  expect(styles).toMatch(
    /\.message-row\[data-enter="new"\] > \.message-row-content\s*\{\s*animation-duration: 120ms !important;/,
  );
  expect(styles).toMatch(
    /\.message-row\[data-pending\]\s*\{\s*opacity: 0\.55;\s*transition: opacity 120ms ease;/,
  );
  expect(styles).toContain("transform-origin: right bottom;");
  expect(styles).not.toMatch(
    /\.message-row(?:\[[^\]]+\])?\s*\{[^}]*content-visibility/,
  );
  expect(chatPane).toContain(
    'data-enter={entranceActive ? "new" : undefined}',
  );
  expect(chatPane).toContain('event.animationName === "message-row-enter"');
  expect(chatPane).toContain(
    'event.animationName === "message-row-enter-reduced"',
  );
  expect(chatPane).toContain("setEntranceActive(false)");
  expect(chatPane).toContain("serverMessageId: accepted.message.id");
  expect(chatPane).toContain(
    "knownMessageIds.current = new Set(messages.map((message) => message.id))",
  );
  expect(chatPane).not.toContain("knownMessageIds.current.add");
  expect(chatPane).not.toContain("content.animate(");
  expect(message).toContain("message-row-content");
});

test("message bubble geometry and grouping match Grokbot", async () => {
  const [styles, chatPane, message] = await Promise.all([
    rendererSource("styles.css"),
    rendererSource("components/openbot/chat-pane.tsx"),
    rendererSource("components/ai-elements/message.tsx"),
  ]);

  expect(styles).toContain("max-width: min(88%, 640px, calc(100% - 82px));");
  expect(styles).toContain("border-radius: 18px;");
  expect(styles).toContain("padding: 8px 12px;");
  expect(styles).toContain("--message-user: #070707;");
  expect(styles).toContain("--message-user-foreground: #fcfcfc;");
  expect(styles).toContain("--message-assistant: #eeeeee;");
  expect(styles).toContain("--message-assistant-foreground: #141414;");
  expect(styles).toContain("--message-user: #5a5a5a;");
  expect(styles).toContain("--message-assistant: #262626;");
  expect(styles).toContain("font-size: 14px;");
  expect(styles).toContain("line-height: 20px;");
  expect(styles).toContain("border-start-end-radius: 6px;");
  expect(styles).toContain("border-end-start-radius: 6px;");
  expect(styles).not.toContain("margin-inline-start: auto;");
  expect(chatPane).toContain("data-group-position={groupPosition}");
  expect(chatPane).toContain('className="max-w-none gap-1 px-4 pt-10"');
  expect(message).toContain("data-role={from}");
});
