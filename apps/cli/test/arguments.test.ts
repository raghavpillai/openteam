import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/arguments";

describe("CLI arguments", () => {
  test("defaults to help", () => {
    expect(parseArguments([]).command).toBe("help");
  });

  test("recognizes the interactive setup command", () => {
    expect(parseArguments(["setup", "--advanced", "--dir", "/tmp/openteam"])).toMatchObject({
      command: "setup",
      advanced: true,
      directory: "/tmp/openteam",
    });
  });

  test("supports operational logs, provider repair, and command-local help", () => {
    expect(parseArguments(["provider", "login"]).command).toBe("provider-login");
    expect(
      parseArguments(["logs", "--follow", "--tail", "50", "--service", "server"])
    ).toMatchObject({ command: "logs", follow: true, tail: "50", service: "server" });
    expect(parseArguments(["setup", "--help"]).command).toBe("help");
  });

  test("parses provider and model management commands", () => {
    expect(parseArguments(["provider", "list"]).command).toBe("provider-list");
    expect(parseArguments(["provider", "login", "Anthropic", "--auth", "api-key"])).toMatchObject({
      command: "provider-login",
      providerId: "anthropic",
      authType: "api_key",
    });
    expect(
      parseArguments([
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
      ])
    ).toMatchObject({
      command: "provider-add",
      providerId: "acme",
      apiProtocol: "openai-responses",
      modelId: "acme-pro",
      reasoning: true,
    });
    expect(parseArguments(["model", "list", "anthropic"])).toMatchObject({
      command: "model-list",
      providerId: "anthropic",
    });
    expect(
      parseArguments(["model", "use", "anthropic", "claude-sonnet-4-5", "--thinking", "high"])
    ).toMatchObject({
      command: "model-use",
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      thinking: "high",
    });
  });

  test("rejects malformed provider configuration", () => {
    expect(() => parseArguments(["provider", "remove", "not valid"])).toThrow("Provider ids");
    expect(() =>
      parseArguments([
        "provider",
        "add",
        "acme",
        "--name",
        "Acme",
        "--base-url",
        "https://example.test",
        "--api",
        "unknown",
        "--model",
        "model-1",
      ])
    ).toThrow("--api must be");
    expect(() =>
      parseArguments(["model", "use", "anthropic", "claude", "--thinking", "ultra"])
    ).toThrow("--thinking must be");
  });

  test("rejects unsafe or malformed log selectors", () => {
    expect(() => parseArguments(["logs", "--tail", "1.5"])).toThrow(
      "--tail must be a whole number"
    );
    expect(() => parseArguments(["logs", "--service", "-f"])).toThrow(
      "--service must be a Compose service name"
    );
    expect(() => parseArguments(["logs", "--service", "server;whoami"])).toThrow(
      "--service must be a Compose service name"
    );
  });

  test("recognizes the nested password reset command", () => {
    expect(parseArguments(["password", "reset", "--dir", "/tmp/openteam"])).toMatchObject({
      command: "password-reset",
      directory: "/tmp/openteam",
    });
    expect(() => parseArguments(["password", "change"])).toThrow("Usage: openteam password reset");
  });

  test("recognizes account updates for either or both credentials", () => {
    expect(parseArguments(["account", "update", "--username", "new.owner"])).toMatchObject({
      command: "account-update",
      username: "new.owner",
      password: false,
    });
    expect(parseArguments(["account", "update", "--password"])).toMatchObject({
      command: "account-update",
      password: true,
    });
    expect(
      parseArguments(["account", "update", "--username", "new.owner", "--password"])
    ).toMatchObject({ command: "account-update", username: "new.owner", password: true });
    expect(() => parseArguments(["account", "reset"])).toThrow("Usage: openteam account update");
    expect(() => parseArguments(["status", "--password"])).toThrow(
      "only valid with openteam account update"
    );
    expect(() => parseArguments(["account", "update", "--password", "secret-value"])).toThrow(
      "does not accept a value"
    );
  });

  test("parses install release options", () => {
    expect(
      parseArguments([
        "install",
        "--version",
        "1.2.3",
        "--dir",
        "/tmp/openteam",
        "--repository",
        "owner/repo",
      ])
    ).toMatchObject({
      command: "install",
      version: "1.2.3",
      directory: "/tmp/openteam",
      repository: "owner/repo",
    });
  });

  test("requires values for value options", () => {
    expect(() => parseArguments(["update", "--version"])).toThrow("--version requires a value");
  });

  test("enables structured progress for desktop-managed server updates", () => {
    expect(parseArguments(["update", "--json-progress"]).jsonProgress).toBe(true);
  });

  test("rejects unknown commands and options", () => {
    expect(() => parseArguments(["explode"])).toThrow("Unknown command");
    expect(() => parseArguments(["status", "--json"])).toThrow("Unknown option");
  });
});
