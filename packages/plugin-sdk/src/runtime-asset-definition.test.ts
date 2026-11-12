import { describe, expect, test } from "bun:test";
import { parsePluginDefinition } from "./manifest";
import { validateRuntimeAssets } from "./runtime-asset-definition";
import { createPluginTemplate } from "./templates";
import type { PluginRuntimeAssetSource } from "./types";

const source = (): PluginRuntimeAssetSource => ({
  url: "https://runtime.example/releases/tool.tar.gz",
  sha256: "a".repeat(64),
  bytes: 100,
  maxExtractedBytes: 1_000,
  format: "tar.gz",
  path: "runtime/bin/tool",
  executable: true,
});
describe("managed runtime manifest validation", () => {
  test.each(["linux", "linux-ia32", "Linux-x64", "linux-x64/../../escape", "darwin-aarch64", "-arm64"])(
    "rejects an invalid platform: %s", (platform) => {
      expect(() => validateRuntimeAssets([{ name: "JAVA", sources: { [platform]: source() } }])).toThrow();
    },
  );

  const invalidSources: Array<[string, Record<string, unknown>]> = [
    ["insecure HTTP", { url: "http://runtime.example/tool" }],
    ["local file", { url: "file:///tmp/tool" }],
    ["URL credentials", { url: "https://user:password@runtime.example/tool" }],
    ["URL fragment", { url: "https://runtime.example/tool#pin" }],
    ["relative URL", { url: "/tool" }],
    ["array URL", { url: ["https://runtime.example/tool"] }],
    ["missing digest", { sha256: undefined }],
    ["short digest", { sha256: "a".repeat(63) }],
    ["uppercase digest", { sha256: "A".repeat(64) }],
    ["nonhex digest", { sha256: "g".repeat(64) }],
    ["array digest", { sha256: ["a".repeat(64)] }],
    ["zero size", { bytes: 0 }],
    ["negative size", { bytes: -1 }],
    ["fractional size", { bytes: 1.5 }],
    ["string size", { bytes: "100" }],
    ["infinite size", { bytes: Infinity }],
    ["oversized download", { bytes: 512 * 1024 * 1024 + 1 }],
    ["smaller extraction limit", { maxExtractedBytes: 99 }],
    ["fractional extraction limit", { maxExtractedBytes: 100.5 }],
    ["missing extraction limit", { maxExtractedBytes: undefined }],
    ["oversized extraction limit", { maxExtractedBytes: 2 * 1024 * 1024 * 1024 + 1 }],
    ["unsupported format", { format: "zip" }],
    ["empty entry", { path: "" }],
    ["absolute entry", { path: "/bin/java" }],
    ["parent traversal", { path: "bin/../../java" }],
    ["dot component", { path: "bin/./java" }],
    ["empty component", { path: "bin//java" }],
    ["trailing slash", { path: "bin/java/" }],
    ["Windows path", { path: "bin\\java" }],
    ["drive path", { path: "C:/java" }],
    ["NUL entry", { path: "bin/ja\0va" }],
    ["control entry", { path: "bin/ja\nva" }],
    ["non-string entry", { path: ["bin/java"] }],
    ["non-boolean executable", { executable: "true" }],
  ];

  test.each(invalidSources)("rejects %s directly and through plugin import", (_label, overrides) => {
    const runtimes = [{ name: "JAVA", sources: { "linux-arm64": { ...source(), ...overrides } } }];
    expect(() => validateRuntimeAssets(runtimes)).toThrow();
    const definition = createPluginTemplate("packaged-mcp", "runtime-example");
    // Import boundaries accept unknown JSON, so do not coerce malformed fields into strings.
    const raw = JSON.parse(JSON.stringify(definition));
    raw.connections[0].runtimeAssets = runtimes;
    expect(() => { parsePluginDefinition(raw); }).toThrow();
  });
});
