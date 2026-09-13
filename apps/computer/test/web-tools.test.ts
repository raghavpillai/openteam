import { expect, test } from "bun:test";
import { isPublicAddress, publicWebGet, publicWebUrl, webMarkdown } from "../src/web-tools";

test("public web reader blocks private, encoded, credentialed and non-HTTP destinations", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ])
    expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress("1.1.1.1")).toBe(true);
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  for (const url of [
    "file:///etc/passwd",
    "http://localhost",
    "http://2130706433",
    "http://0x7f000001",
    "http://[::ffff:7f00:1]",
    "https://user:pass@example.com",
  ])
    expect(() => publicWebUrl(url)).toThrow();
  await expect(publicWebGet("http://127.0.0.1/")).rejects.toThrow();
});

test("HTML conversion keeps article structure and absolute citations without active content", () => {
  const html =
    '<html><head><title>Test</title><script>PRIVATE_SCRIPT</script></head><body><article><h1>Heading</h1><p>Useful article with a <a href="/source">citation</a> and <strong>detail</strong>.</p><pre><code>const value = 1;</code></pre></article><form><input value="PRIVATE_FIELD"></form></body></html>';
  const result = webMarkdown(html, "https://example.com/page");
  expect(result).toContain("# Heading");
  expect(result).toContain("[citation](https://example.com/source)");
  expect(result).toContain("const value = 1;");
  expect(result).not.toContain("PRIVATE_");
});
