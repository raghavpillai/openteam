import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/arguments";

describe("CLI arguments", () => {
  test("defaults to help", () => {
    expect(parseArguments([]).command).toBe("help");
  });

  test("recognizes the interactive setup command", () => {
    expect(parseArguments(["setup", "--advanced", "--dir", "/tmp/openbot"])).toMatchObject({
      command: "setup",
      advanced: true,
      directory: "/tmp/openbot",
    });
  });

  test("recognizes the nested password reset command", () => {
    expect(parseArguments(["password", "reset", "--dir", "/tmp/openbot"])).toMatchObject({
      command: "password-reset",
      directory: "/tmp/openbot",
    });
    expect(() => parseArguments(["password", "change"])).toThrow("Usage: openbot password reset");
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
    expect(() => parseArguments(["account", "reset"])).toThrow("Usage: openbot account update");
    expect(() => parseArguments(["status", "--password"])).toThrow(
      "only valid with openbot account update"
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
        "/tmp/openbot",
        "--repository",
        "owner/repo",
      ])
    ).toMatchObject({
      command: "install",
      version: "1.2.3",
      directory: "/tmp/openbot",
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
