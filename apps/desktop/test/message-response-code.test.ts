import { afterEach, describe, expect, test } from "bun:test";
import {
  clearCodeHighlighterCaches,
  code,
  codeHighlighterCacheLimits,
  getCodeHighlighterCacheStats,
} from "../src/renderer/components/ai-elements/message-response-code";
import { grokShikiTheme } from "../src/renderer/components/ai-elements/message-response-config";

type HighlightResult = NonNullable<ReturnType<typeof code.highlight>>;

const highlight = (source: string, language: string) =>
  new Promise<HighlightResult>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Highlighting timed out")), 5_000);
    const finish = (result: HighlightResult) => {
      clearTimeout(timeout);
      resolve(result);
    };
    const immediate = code.highlight({ code: source, language, themes: grokShikiTheme }, finish);
    if (immediate) finish(immediate);
  });

afterEach(() => {
  clearCodeHighlighterCaches();
});

describe("OpenTeam code highlighter", () => {
  test("retains bundled language aliases and the configured light/dark colors", async () => {
    expect(code.supportsLanguage("ts")).toBe(true);
    expect(code.supportsLanguage("PYTHON")).toBe(true);
    expect(code.supportsLanguage("not-a-language")).toBe(false);
    expect(code.getSupportedLanguages()).toContain("typescript");

    const result = await highlight("const answer: number = 42;", "ts");
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].length).toBeGreaterThan(1);
    expect(result.bg).toContain("#fcfcfc");
    expect(result.bg).toContain("--shiki-dark-bg:#24292e");
    expect(result.tokens[0].some((token) => token.htmlStyle?.["--shiki-dark"])).toBe(true);
  });

  test("coalesces duplicate work and returns the cached result synchronously", async () => {
    const source = "function square(value: number) { return value * value; }";
    const first = highlight(source, "typescript");
    const second = highlight(source, "ts");
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toBe(firstResult);
    const cached = code.highlight({ code: source, language: "ts", themes: grokShikiTheme });
    expect(cached).toBe(firstResult);
    expect(getCodeHighlighterCacheStats()).toMatchObject({
      highlighterEntries: 1,
      tokenEntries: 1,
    });
  });

  test("falls back to visible plain tokens for unknown languages", () => {
    const result = code.highlight({
      code: "first\nsecond",
      language: "not-a-language",
      themes: grokShikiTheme,
    });

    expect(result?.tokens.map((line) => line[0]?.content)).toEqual(["first", "second"]);
  });

  test("keeps oversized supported-language fences readable without scheduling Shiki", () => {
    const source = "x".repeat(codeHighlighterCacheLimits.highlightSourceCharacters + 1);
    const result = code.highlight({ code: source, language: "javascript", themes: grokShikiTheme });

    expect(result?.tokens[0][0]?.content).toBe(source);
    expect(getCodeHighlighterCacheStats()).toMatchObject({
      highlighterEntries: 0,
      pendingCharacters: 0,
      pendingHighlights: 0,
    });
  });

  test("keeps the completed-token cache inside its entry and cost budgets", async () => {
    for (let index = 0; index < codeHighlighterCacheLimits.tokenEntries + 8; index += 1) {
      await highlight(`const value = ${index};`, "javascript");
    }

    const stats = getCodeHighlighterCacheStats();
    expect(stats.tokenEntries).toBeLessThanOrEqual(codeHighlighterCacheLimits.tokenEntries);
    expect(stats.tokenCost).toBeLessThanOrEqual(codeHighlighterCacheLimits.tokenCost);
    expect(stats.highlighterEntries).toBeLessThanOrEqual(
      codeHighlighterCacheLimits.highlighterEntries
    );
  });
});
