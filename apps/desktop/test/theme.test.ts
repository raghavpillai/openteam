import { describe, expect, test } from "bun:test";
import { normalizeThemePreference, resolveTheme } from "../src/renderer/lib/theme";

describe("desktop theme preference", () => {
  test("normalizes persisted values", () => {
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("unexpected")).toBe("system");
  });

  test("resolves system and explicit themes", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
