import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApprovalCard } from "@openteam/contracts/auto-review";
import { renderToStaticMarkup } from "react-dom/server";

type Module = typeof import("../src/renderer/components/openteam/approval-card");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let view: Module;

beforeAll(async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "http://127.0.0.1:5173/" } } });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key), setItem: (key: string, value: string) => values.set(key, value) },
  });
  view = await import("../src/renderer/components/openteam/approval-card");
});

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete (globalThis as { window?: unknown }).window;
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const card: ApprovalCard = {
  type: "approval",
  surface: "box_shell",
  fingerprint: "f",
  summary: "Push the release branch on OpenTeam's computer",
  reason: "Push the release branch to GitHub. This publishes commits others can see.",
  command: "git push origin release",
  proposedRule: 'Run "git push" commands on OpenTeam\'s computer',
  expiryPolicy: "park",
  cardState: "pending",
  expiresAt: null,
  presentation: {
    title: "Allow Ada to run a command?",
    line: "Push the release branch on OpenTeam's computer.",
    source: "Terminal",
    sourceIcon: "terminal",
    caution: "This shares your data outside this chat",
  },
};
const render = (value: ApprovalCard, extra: { error?: string } = {}) =>
  renderToStaticMarkup(<view.ApprovalCardView botName="Ada" busy={false} card={value} onAnswer={() => {}} {...extra} />);
const text = (html: string) => html.replace(/<[^>]+>/g, "\n").split("\n").map((part) => part.trim()).filter(Boolean);

describe("Auto-review approval card", () => {
  test("a pending card names the action and offers Always allow, Allow once and Deny", () => {
    const html = render(card);
    expect(html).toContain('aria-label="Allow Ada to run a command?: Push the release branch on OpenTeam&#x27;s computer"');
    expect(text(html)).toEqual([
      "Terminal",
      "Allow Ada to run a command?",
      "Needs approval",
      "Push the release branch on OpenTeam&#x27;s computer.",
      "This shares your data outside this chat",
      "View the full request",
      "Always allow saves: Run &quot;git push&quot; commands on OpenTeam&#x27;s computer",
      "Always allow",
      "Allow once",
      "Deny",
    ]);
    expect(html).toContain('title="Deny once (Esc)"');
    // Without a proposed rule there is one Allow.
    expect(text(render({ ...card, proposedRule: undefined })).slice(-2)).toEqual(["Allow", "Deny"]);
    expect(text(render({ ...card, appliedRules: [{ effect: "ask_first", text: "Ask before any push" }] }))).toContain("Paused by your Ask first rule: Ask before any push");
  });

  test("a settled card shows its outcome and no buttons", () => {
    expect(text(render({ ...card, cardState: "approved" }))).toEqual(["Terminal", "Allow Ada to run a command?", "Allowed once", "Push the release branch on OpenTeam&#x27;s computer.", "View the full request"]);
    expect(text(render({ ...card, cardState: "denied" })).slice(2)).toEqual(["Denied", "Push the release branch on OpenTeam&#x27;s computer.", "View the full request", "Ada won&#x27;t do this"]);
    expect(text(render({ ...card, cardState: "expired" })).at(-1)).toBe("No answer in time, so Ada didn&#x27;t do this");
    expect(text(render({ ...card, cardState: "always", savedRule: card.proposedRule })).slice(2)).toEqual([
      "Always allowed",
      "Push the release branch on OpenTeam&#x27;s computer.",
      "View the full request",
      "Allowed from now on: Run &quot;git push&quot; commands on OpenTeam&#x27;s computer",
    ]);
    expect(render({ ...card, cardState: "denied" })).not.toContain("<button class=\"draft-button");
  });

  test("a routine card quotes its instruction, and a failed answer says so", () => {
    const routine = render({
      ...card,
      surface: "automation_write",
      presentation: { title: "Allow Ada to save a routine?", line: "Save the routine “Digest” to run every weekday at 9:00.", quote: "Email me the summary", source: "Auto-review", sourceIcon: "shield" },
    }, { error: "Your answer didn't go through. Check your connection and try again." });
    expect(text(routine)).toContain("“Email me the summary”");
    expect(routine).toContain('role="alert"');
    expect(view.detailText("x".repeat(345))).toBe(`${"x".repeat(340)}...[5 chars omitted]`);
  });
});

describe("Auto-review settings", () => {
  test("show the switch and both rule lists, and say when rules are unused", async () => {
    const { AutoReviewSettingsSection } = await import("../src/renderer/components/openteam/settings/auto-review");
    const on = text(renderToStaticMarkup(<AutoReviewSettingsSection initial={{ enabled: true, allowRules: ["Emails to a@x.com"], askFirstRules: [] }} />));
    expect(on).toEqual([
      "Auto-review",
      "Auto-review",
      "OpenTeam checks each action before it runs and asks you first when needed. Add rules to customize what it can do automatically.",
      "Allow rules",
      "OpenTeam usually goes ahead without asking for anything that matches, unless an Ask first rule also matches. Built-in safety checks still apply.",
      "Emails to a@x.com",
      "Add Allow rule",
      "Ask first rules",
      "OpenTeam stops and asks you before anything that matches, even if it would otherwise go ahead. Ask first wins over Allow.",
      "Add Ask first rule",
      "These rules apply only to you. Built-in safety checks always apply.",
    ]);
    const off = text(renderToStaticMarkup(<AutoReviewSettingsSection initial={{ enabled: false, allowRules: [], askFirstRules: [] }} />));
    expect(off).toContain("OpenTeam runs actions without checking them. Tools set to Needs approval still ask.");
    expect(off.at(-1)).toBe("Rules aren&#x27;t used while Auto-review is off");
  });
});
