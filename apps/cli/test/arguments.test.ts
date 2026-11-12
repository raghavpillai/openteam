import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/arguments";

describe("CLI arguments", () => {
  test.each([
    [[], { command: "help", helpTopic: "global" }],
    [["model", "--dir", "/tmp/m"], { command: "model", directory: "/tmp/m" }],
    [["help", "provider", "add"], { command: "help", helpTopic: "provider-add" }],
    [["provider", "login", "--help"], { command: "help", helpTopic: "provider-login" }],
    [["setup", "--advanced", "--dir", "/tmp/o"], { command: "setup", advanced: true }],
    [["logs", "server", "-f", "--tail", "50"], { command: "logs", follow: true, tail: "50" }],
    [
      ["provider", "login", "Anthropic", "--auth", "api-key"],
      { command: "provider-login", providerId: "anthropic", authType: "api_key" },
    ],
    [
      [
        "provider",
        "add",
        "acme",
        "--name",
        "Acme AI",
        "--base-url",
        "https://ai.example.test/v1",
        "--api",
        "openai-responses",
        "--model",
        "acme-pro",
        "--reasoning",
      ],
      { command: "provider-add", apiProtocol: "openai-responses", reasoning: true },
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
    [["update", "--json-progress"], { command: "update", jsonProgress: true }],
  ] as const)("parses %j", (args, expected) => {
    expect(parseArguments([...args])).toMatchObject(expected);
  });

  test("health is an alias for status", () => {
    for (const args of [[], ["--dir", "/tmp/team"], ["--json-progress"], ["--help"]])
      expect(parseArguments(["health", ...args])).toEqual(parseArguments(["status", ...args]));
  });

  test.each([
    [["explode"], "Unknown command"],
    [["statsu"], 'Did you mean "status"?'],
    [["status", "--force"], "Unknown option for status"],
    [["install", "--purge"], "Unknown option for install"],
    [["update", "--version"], "--version requires a value"],
    [["provider", "remove", "not valid"], "Provider ids"],
    [["model", "use", "anthropic", "claude", "--thinking", "ultra"], "--thinking must be"],
    [["logs", "--tail", "1.5"], "--tail must be a whole number"],
    [["logs", "--service", "-f"], "--service must be a Compose service name"],
    [["logs", "--service", "server;whoami"], "--service must be a Compose service name"],
    [["account", "update", "--password", "secret-value"], "does not accept a value"],
    [["password", "reset"], "use openteam account update --password"],
    [["notifications", "configure", "--private-key", "secret"], "Unknown option"],
  ] as const)("rejects %j", (args, message) => {
    expect(() => parseArguments([...args])).toThrow(message);
  });
});
