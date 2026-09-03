import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const rendererSource = (path: string) =>
  readFile(new URL(`../src/renderer/${path}`, import.meta.url), "utf8");

test("A2A exchange motion matches the observed Grok sheet and footer timing", async () => {
  const [styles, chatPane] = await Promise.all([
    rendererSource("styles.css"),
    rendererSource("components/openteam/chat-pane.tsx"),
  ]);

  expect(styles).toMatch(
    /\.a2a-exchange-sheet\[data-state="entering"\]\s*\{\s*animation: a2a-exchange-sheet-enter 120ms/
  );
  expect(styles).toMatch(
    /\.a2a-exchange-sheet\[data-state="exiting"\]\s*\{\s*animation: a2a-exchange-sheet-exit 120ms/
  );
  expect(styles).toMatch(
    /\.a2a-exchange-footer\s*\{\s*animation: a2a-exchange-footer-enter 120ms[\s\S]*?300ms both;/
  );
  expect(styles).toMatch(
    /\.a2a-exchange-sheet\[data-state="exiting"\] \.a2a-exchange-footer\s*\{\s*animation: a2a-exchange-footer-exit 120ms/
  );
  expect(styles).toContain("transform: translateY(20px);");
  expect(styles).toContain("transform: translateY(6px);");
  expect(chatPane).toContain('className="a2a-exchange-footer');
});

test("A2A activity only makes the peer chip interactive", async () => {
  const chatPane = await rendererSource("components/openteam/chat-pane.tsx");
  const activityStart = chatPane.indexOf("const A2AActivityRow");
  const activityEnd = chatPane.indexOf("export const ChatPane", activityStart);
  const activity = chatPane.slice(activityStart, activityEnd);

  expect(activity).toMatch(/<div[\s\S]*?data-a2a-activity=""/);
  expect(activity).not.toMatch(/<button[\s\S]*?data-a2a-activity=""/);
  expect(activity).toMatch(
    /<button[\s\S]*?data-a2a-peer-pill=""[\s\S]*?onClick=\{\(event\) => onOpen\(event\.currentTarget\)\}/
  );
  expect(activity).toContain("hover:bg-[#efefef]");
  expect(activity).not.toContain("group-hover/a2a");
});
