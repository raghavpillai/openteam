import { expect, test } from "bun:test";
import {
  validateValues,
  validateMcpUrl,
} from "../src";

test("MCP URL fields normalize reachable schemes and reject credential-bearing or insecure links", () => {
  for (const value of [
    "https://environment.example/mcp",
    "http://localhost:3773/mcp",
    "http://127.0.0.1:3773/mcp",
    "http://[::1]:3773/mcp",
  ]) {
    expect(
      validateValues(
        [{ key: "url", label: "MCP URL", format: "mcp-url", required: true, secret: false }],
        { url: ` ${value} ` }
      ).url
    ).toBe(value);
  }
  for (const value of [
    "AUTO-example",
    "environment.example/mcp",
    "http://100.64.1.2:3773/mcp",
    "http://192.168.1.2:3773/mcp",
    "https://user:pass@example.com/mcp",
    "https://example.com/pair#code=private",
    "https://example.com/mcp#",
    "https://example.com/mcp?token=private",
    "https://example.com/mcp?code=private",
    "file:///tmp/mcp",
    "javascript:alert(1)",
  ]) {
    expect(() => validateMcpUrl(value)).toThrow();
  }
});
