import { expect, test } from "bun:test";
import { targetForPlatform } from "./download-options";

test("suggests desktop builds only for desktops: Apple silicon (the Mac fallback), Windows and Linux", () => {
  expect(targetForPlatform("macOS", "Mozilla/5.0 (Macintosh)", "arm64")).toBe("mac-arm64");
  expect(targetForPlatform("macOS", "Mozilla/5.0 (Macintosh)", "x86_64")).toBeNull();
  expect(targetForPlatform("MacIntel", "Mozilla/5.0 (Macintosh)", "")).toBe("mac-arm64");
  expect(targetForPlatform("Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "x86_64", 10)).toBe("windows-x64");
  expect(targetForPlatform("Linux", "Mozilla/5.0", "x86_64")).toBe("linux-x64");
  expect(targetForPlatform("", "Mozilla/5.0", "")).toBeNull();
});

test("does not recommend desktop builds to phones and tablets", () => {
  expect(targetForPlatform("Linux armv8l", "Mozilla/5.0 (Linux; Android 15; Pixel 9)", "arm64", 5)).toBeNull();
  expect(targetForPlatform("iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)", "", 5)).toBeNull();
  // iPadOS reports a Mac; touch points give it away.
  expect(targetForPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "", 5)).toBeNull();
});
