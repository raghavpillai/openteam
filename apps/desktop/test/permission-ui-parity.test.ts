import { describe, expect, test } from "bun:test";

const source = () =>
  Bun.file(new URL("../src/renderer/components/openteam/chat-pane.tsx", import.meta.url)).text();
const productSource = () =>
  Bun.file(new URL("../../../packages/product-core/src/activity.ts", import.meta.url)).text();
const styles = () => Bun.file(new URL("../src/renderer/styles.css", import.meta.url)).text();

describe("Bot permission UI parity", () => {
  test("keeps the local-computer gate structurally separate from Auto-review", async () => {
    const value = await source();
    expect(value).toContain('aria-label="Local tool permission"');
    expect(value).toContain('aria-label="Deny once"');
    expect(value).toContain(
      "This applies to OpenTeam and every Bot. It can always be changed in Settings."
    );
    expect(value).toContain("Always allow");
    expect(value).toContain("Allow once");
    expect(value).toContain("Never");
    expect(value).toContain('data-local-tool-permission-result=""');
  });

  test("supports the exact command and task Auto-review variants", async () => {
    const [value, product] = await Promise.all([source(), productSource()]);
    expect(value).toContain("approvalPresentation(approval)");
    expect(product).toContain("The Bot wants to run a command");
    expect(product).toContain("The Bot wants to run a task");
    expect(product).toContain('const taskReview = action === "runTask"');
    expect(value).toContain("Show the ${detailsLabel}");
    expect(value).toContain('aria-label="Copy code"');
    expect(value).toContain('approval.status === "declined"');
    expect(value).toContain("if (!pending) setDetailsOpen(false)");
    expect(value).toContain("Runs on your local computer");
    expect(value).toContain("A rule always allowing this was added to your Auto-review settings${");
  });

  test("locks the extracted Bot card tokens and pending-dock geometry", async () => {
    const value = await source();
    expect(value).toContain("gap-3 rounded-2xl bg-[#eeeeee] p-3");
    expect(value).toContain("dark:bg-[#262626]");
    expect(value).toContain("text-[14px] font-medium leading-[22px]");
    expect(value).toContain("h-8 rounded-lg px-2.5");
    expect(value).toContain("text-[13px] leading-[18px]");
    expect(value).toContain('entry.type !== "approval" || !isPendingLocalApproval(entry.approval)');
    expect(value).toContain('data-local-tool-permission-dock=""');
    expect(value).toContain(
      'className="pointer-events-auto relative z-[3] w-full min-w-0 px-4 pb-2"'
    );
    expect(value).toMatch(
      /isResolvedLocalApproval\(entry\.approval\)\s*\?\s*"mt-2 w-full min-w-0"/
    );
    expect(value).toContain("max-w-[min(88%,520px,calc(100%-82px))]");
    expect(value).toContain("!hasPendingApproval");
    expect(value).toContain("<BotThinkingSlot");
  });

  test("matches Bot's disclosure, code block, and hover-copy treatment", async () => {
    const [value, css] = await Promise.all([source(), styles()]);

    expect(value).toContain("[overflow-wrap:anywhere]");
    expect(value).toContain("overflow-auto whitespace-pre px-3 py-2");
    expect(value).toContain("approval-code-figure");
    expect(value).toContain("approval-copy-button absolute right-1.5 top-1.5");
    expect(value).toContain("dark:bg-[#f0f0f0] dark:text-[#181818]");
    expect(css).toContain("@media (hover: hover) and (pointer: fine)");
    expect(css).toContain(".approval-code-figure:hover .approval-copy-button");
  });
});
