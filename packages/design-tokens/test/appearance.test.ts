import { expect, test } from "bun:test";
import { nativeThemePreference, normalizeThemePreference, resolveTheme } from "../src/appearance";

test("appearance preferences normalize and resolve predictably", () => {
  expect(normalizeThemePreference("dark")).toBe("dark");
  expect(normalizeThemePreference("sepia")).toBe("system");
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});

test("system appearance releases the native override", () => {
  expect(nativeThemePreference("system")).toBe("unspecified");
  expect(nativeThemePreference("light")).toBe("light");
  expect(nativeThemePreference("dark")).toBe("dark");
});
