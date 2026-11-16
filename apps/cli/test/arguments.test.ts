import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/arguments";

describe("CLI arguments", () => {
  test.each([
    [[], { command: "help", helpTopic: "global" }],
    [["logs", "server", "-f", "--tail", "50"], { command: "logs", follow: true, tail: "50" }],
    [
      ["provider", "login", "Anthropic", "--auth", "api-key"],
      { command: "provider-login", providerId: "anthropic", authType: "api_key" },
    ],
    [
      ["model", "use", "anthropic", "claude-sonnet-4-5", "--thinking", "high"],
      { command: "model-use", modelId: "claude-sonnet-4-5", thinking: "high" },
    ],
    [
      ["account", "update", "--username", "new.owner", "--password"],
      { command: "account-update", username: "new.owner", password: true },
    ],
    [
      ["install", "--version", "1.2.3", "--repository", "owner/repo", "--allow-prerelease"],
      { command: "install", version: "1.2.3", repository: "owner/repo", allowPrerelease: true },
    ],
  ] as const)("parses %j", (args, expected) => {
    expect(parseArguments([...args])).toMatchObject(expected);
  });

  test("health is an alias for status", () => {
    for (const args of [[], ["--dir", "/tmp/team"], ["--json-progress"], ["--help"]])
      expect(parseArguments(["health", ...args])).toEqual(parseArguments(["status", ...args]));
  });

  test.each([
    [["statsu"], 'Did you mean "status"?'],
    [["status", "--force"], "Unknown option for status"],
    [["update", "--version"], "--version requires a value"],
    [["provider", "remove", "not valid"], "Provider ids"],
    [["model", "use", "anthropic", "claude", "--thinking", "ultra"], "--thinking must be"],
    [["logs", "--service", "-f"], "--service must be a Compose service name"],
    [["logs", "--service", "server;whoami"], "--service must be a Compose service name"],
    [["account", "update", "--password", "secret-value"], "does not accept a value"],
    [["password", "reset"], "use openteam account update --password"],
    [["notifications", "configure", "--private-key", "secret"], "Unknown option"],
  ] as const)("rejects %j", (args, message) => {
    expect(() => parseArguments([...args])).toThrow(message);
  });
});
