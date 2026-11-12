import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { advancedMessageCapabilitiesFor } from "../../src/renderer/components/ai-elements/message-response/capabilities";
import {
  messageRemarkPlugins,
  prepareMessageMarkdown,
} from "../../src/renderer/components/ai-elements/message-response/markdown-source";
import { math } from "../../src/renderer/components/ai-elements/message-response/math";
import { normalizeMessageMath } from "../../src/renderer/components/ai-elements/message-response/math-markdown";

const render = (source: string, mode: "static" | "streaming" = "static") =>
  renderToStaticMarkup(
    <Streamdown
      controls={{ table: false }}
      linkSafety={{ enabled: false }}
      mode={mode}
      plugins={{ math }}
      remarkPlugins={messageRemarkPlugins}
    >
      {prepareMessageMarkdown(source)}
    </Streamdown>
  );
const equations = (html: string) => (html.match(/class="katex"/g) ?? []).length;
const text = (html: string) => html.replace(/<br\s*\/?>\n?/g, "\n").replace(/<[^>]*>/g, "");

describe("currency and math rendering", () => {
  test("keeps the flight recommendation readable with all dollar signs and spaces", () => {
    const source =
      "**Best balance: United at 11:00**, about $4 cheaper than Ramp. " +
      "Lufthansa is the fastest. Love Field also appeared, but it is $1,944. Prices can change.";
    expect(advancedMessageCapabilitiesFor(source)).toBeNull();
    for (const mode of ["static", "streaming"] as const) {
      const html = render(source, mode);
      expect(equations(html)).toBe(0);
      expect(html).toContain("$4 cheaper than Ramp. Lufthansa is the fastest.");
      expect(html).toContain("$1,944. Prices can change.");
      expect(html).toContain('data-streamdown="strong"');
    }
  });

  test.each([
    "$1,290 vs $1,944",
    "$4–$5",
    "$4-$5",
    "$0.50 and $.75",
    "$-4 and $+5",
    "$4\n$5",
  ])("does not interpret prices as math: %s", (source) => {
    expect(advancedMessageCapabilitiesFor(source)).toBeNull();
    const html = render(source);
    expect(equations(html)).toBe(0);
    expect(html.replace(/<[^>]*>/g, "")).toBe(source);
  });

  test.each([
    "$4 cheaper. Solve $x+1=2$ for $5.",
    "Solve $x+1=2$; $4 cheaper than $5.",
    "$4 cheaper. Solve $2+2=4$ for $5.",
    "$4 cheaper. Solve $\\alpha=2$ for $5.",
    "$4 cheaper. Solve **$x+1=2$** for $5.",
    "$4 cheaper. Solve \\(x+1=2\\) for $5.",
    "$4 cheaper. Solve $$x+1=2$$ for $5.",
    "$4 cheaper.\n\n$$\nx+1=2\n$$\n\nCosts $5.",
  ])("preserves math alongside currency: %s", (source) => {
    expect(advancedMessageCapabilitiesFor(source)?.math).toBe(true);
    for (const mode of ["static", "streaming"] as const) {
      const html = render(source, mode);
      expect(equations(html)).toBe(1);
      expect(html).toContain("$4 cheaper");
      expect(html).toContain("$5.");
    }
  });

  test.each([
    "$x + 1 = 2$",
    "$2 + 2 = 4$",
    "$4$",
    "$2 + 2 $",
    "$2+2$+3",
    "$2 < 3$ and $4 > 2$",
    "$$x^2$$",
    "$$\nx^2\n$$",
    "\\(x^2\\)",
    "\\[x^2\\]",
  ])("retains existing math syntax: %s", (source) => {
    expect(advancedMessageCapabilitiesFor(source)?.math).toBe(true);
    expect(equations(render(source))).toBe(source.includes(" and ") ? 2 : 1);
  });

  test("leaves escaped currency, code, links and math text intact", () => {
    expect(equations(render("$x$ and $ 2 + 2 $"))).toBe(2);
    expect(equations(render("$x$ and $2\n+2$"))).toBe(2);
    for (const source of [
      "\\$4 and \\$5",
      "`$4 and $5`",
      "```sh\necho '$4 and $5'\n```",
      "~~~text\n$4 and $5\n~~~",
      String.raw`$\text{Costs \$4}$`,
    ]) {
      expect(normalizeMessageMath(source)).toBe(source);
    }
    const html = render("[$4 option](https://example.com/offer/$4) and $5.");
    expect(equations(html)).toBe(0);
    expect(html).toContain('href="https://example.com/offer/$4"');
    expect(html).toContain(">$4 option</a>");
  });

  test.each([
    "```sh\necho '$4 and $5'",
    "~~~text\n$4 and $5",
    "````text\n```\n$4 and $5\n```\n````",
    "``price `$4` and `$5` ``",
    "`$4\nand $5`",
    "https://example.com/$4/$5",
    "<https://example.com/$4/$5>",
  ])("does not rewrite literal content: %s", (source) => {
    expect(normalizeMessageMath(source)).toBe(source);
  });
});

describe("message tables and line breaks", () => {
  test("renders a currency table without treating prices as math", () => {
    const source = [
      "Checking `1234` · Sep 28–Oct 12",
      "",
      "| Date | Transaction | Money in | Money out | Status |",
      "|---|---|---:|---:|---|",
      "| Oct 10 | Coffee refund | $0.33 | — | Pending |",
      "| Oct 8 | Brokerage transfer | — | $4,000.00 | Posted |",
      "| **Posted total** | | **$1,250.00** | **$4,000.00** | |",
      "",
      "**Net posted change: −$2,750.00**, plus **$0.33 pending**.",
    ].join("\n");
    const html = render(source);

    expect(html.match(/data-streamdown="table-row"/g)).toHaveLength(4);
    expect(html).not.toContain('class="katex"');
    expect(text(html)).toContain("$1,250.00");
  });

  test("keeps one-item-per-line replies on separate lines", () => {
    const source =
      "Here they are for `1234`:\n\nOct 10: +$0.33 Coffee refund\nOct 8: −$4,000 Brokerage transfer\nOct 2: +$550.05 Payroll";
    const html = render(source);

    expect(html.match(/<br\s*\/?>/g)).toHaveLength(2);
    expect(text(html)).toContain(
      "Oct 10: +$0.33 Coffee refund\nOct 8: −$4,000 Brokerage transfer\nOct 2: +$550.05 Payroll"
    );
  });

  test("leaves code blocks, hard breaks and paragraph breaks unchanged", () => {
    const html = render("one  \ntwo\n\nthree\n\n```text\na\nb\n```");

    // Only the existing hard break: code lines and paragraph gaps add none.
    expect(html.match(/<br\s*\/?>/g)).toHaveLength(1);
    expect(text(html)).toContain("one\ntwo");
  });
});

test("routes OpenTeam in-app links through the safe in-app handler", () => {
  expect(
    prepareMessageMarkdown(
      "Open [Update Track](openteam://app/v1/settings?id=update-channel) or [Plugins](openteam://app/v1/plugin/add?id=calendar)."
    )
  ).toBe(
    "Open [Update Track](streamdown:openteam://app/v1/settings?id=update-channel) or [Plugins](streamdown:openteam://app/v1/plugin/add?id=calendar)."
  );
});
