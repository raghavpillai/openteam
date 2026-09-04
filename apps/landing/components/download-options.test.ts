import { describe, expect, test } from "bun:test";
import { targetForPlatform } from "./download-options";

describe("download target detection", () => {
  test("uses client hints to distinguish Apple silicon from Intel", () => {
    expect(targetForPlatform("macOS", "Mozilla/5.0 (Macintosh)", "arm64")).toBe("mac-arm64");
    expect(targetForPlatform("macOS", "Mozilla/5.0 (Macintosh)", "x86_64")).toBe("mac-x64");
  });

  test("keeps a safe Mac fallback and detects Windows and Linux", () => {
    expect(targetForPlatform("MacIntel", "Mozilla/5.0 (Macintosh)", "")).toBe("mac-arm64");
    expect(targetForPlatform("Windows", "Mozilla/5.0", "x86_64")).toBe("windows-x64");
    expect(targetForPlatform("Linux", "Mozilla/5.0", "x86_64")).toBe("linux-x64");
  });

  test("does not guess for an unknown platform", () => {
    expect(targetForPlatform("", "Mozilla/5.0", "")).toBeNull();
  });
});
