import { describe, expect, test } from "bun:test";
import { targetForPlatform } from "./download-options";

describe("download target detection", () => {
  test("suggests the Apple silicon build, and nothing for Intel Macs", () => {
    expect(targetForPlatform("macOS", "Mozilla/5.0 (Macintosh)", "arm64")).toBe("mac-arm64");
    expect(targetForPlatform("macOS", "Mozilla/5.0 (Macintosh)", "x86_64")).toBeNull();
  });

  test("keeps a safe Mac fallback and detects Windows and Linux", () => {
    expect(targetForPlatform("MacIntel", "Mozilla/5.0 (Macintosh)", "")).toBe("mac-arm64");
    expect(targetForPlatform("Windows", "Mozilla/5.0", "x86_64")).toBe("windows-x64");
    expect(targetForPlatform("Linux", "Mozilla/5.0", "x86_64")).toBe("linux-x64");
  });

  test("does not recommend desktop builds to phones and tablets", () => {
    expect(targetForPlatform("Linux armv8l", "Mozilla/5.0 (Linux; Android 15; Pixel 9)", "arm64", 5)).toBeNull();
    expect(targetForPlatform("iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)", "", 5)).toBeNull();
    expect(targetForPlatform("iPad", "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X)", "", 5)).toBeNull();
    expect(targetForPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", "", 5)).toBeNull();
    expect(targetForPlatform("Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "x86_64", 10)).toBe("windows-x64");
  });

  test("does not guess for an unknown platform", () => {
    expect(targetForPlatform("", "Mozilla/5.0", "")).toBeNull();
  });
});
