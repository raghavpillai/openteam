import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { advancedMessageCapabilitiesFor } from "../../src/renderer/components/ai-elements/message-response/capabilities";
import { math } from "../../src/renderer/components/ai-elements/message-response/math";
import { normalizeMessageMath } from "../../src/renderer/components/ai-elements/message-response/math-markdown";

const render = (source: string, mode: "static" | "streaming" = "static") =>
  renderToStaticMarkup(
    createElement(
      Streamdown,
      { plugins: { math }, mode, linkSafety: { enabled: false } },
      normalizeMessageMath(source)
    )
  );
const equations = (html: string) => (html.match(/class="katex"/g) ?? []).length;

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
