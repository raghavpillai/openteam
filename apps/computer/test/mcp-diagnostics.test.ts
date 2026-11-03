import { expect, test } from "bun:test";
import { McpDiagnostics } from "../src/mcp-diagnostics";

test("recognizes Slack authentication codes across chunks without exposing log content", () => {
  const diagnostics = new McpDiagnostics();
  const line = JSON.stringify({ app: "slack-mcp-server", level: "fatal", error: "invalid_auth", message: "secret-token" });
  for (const char of line) diagnostics.write(char);
  diagnostics.end();
  expect(diagnostics.authenticationError).toContain("Slack rejected the saved browser session (invalid_auth)");
  expect(diagnostics.authenticationError).toContain("same current Slack session");
  expect(diagnostics.authenticationError).not.toContain("secret-token");
});

test("ignores unrelated, malformed, oversized, and non-error logs", () => {
  const diagnostics = new McpDiagnostics();
  for (const line of [
    "invalid_auth",
    JSON.stringify({ app: "another-provider", level: "error", error: "invalid_auth" }),
    JSON.stringify({ app: "slack-mcp-server", level: "info", error: "invalid_auth" }),
    JSON.stringify({ app: "slack-mcp-server", level: "fatal", error: "connection_refused" }),
    JSON.stringify({ app: "slack-mcp-server", level: "fatal", error: "invalid_auth", message: "a".repeat(20_000) }),
  ]) diagnostics.write(line + "\n");
  expect(diagnostics.authenticationError).toBeUndefined();
  diagnostics.write('{"app":"slack-mcp-server","level":"fatal","error":"account_inactive"}\n');
  expect(diagnostics.authenticationError).toContain("Restore account access");
});
