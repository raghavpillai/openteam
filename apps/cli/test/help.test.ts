import { describe, expect, test } from "bun:test";
import { helpFor } from "../src/help";

describe("CLI help", () => {
  test("keeps global help concise and grouped", () => {
    const help = helpFor("global");
    expect(help).toContain("provider      Manage AI accounts and connections");
    expect(help).toContain("model         View or change the AI model");
    expect(help).not.toContain("provider login [provider]");
    expect(help).not.toContain("--compose-url");
    expect(help).not.toContain("--password");
  });

  test("shows only relevant options on command help pages", () => {
    const logs = helpFor("logs");
    expect(logs).toContain("openteam logs [service] [options]");
    expect(logs).toContain("--follow, -f");
    expect(logs).not.toContain("--allow-prerelease");

    const account = helpFor("account-update");
    expect(account).toContain("--username <name>");
    expect(account).toContain("--password");
    expect(account).not.toContain("password reset");
  });

  test("keeps release overrides on install and update help only", () => {
    expect(helpFor("install")).toContain("Advanced release/testing options:");
    expect(helpFor("install")).toContain("--image-prefix");
    expect(helpFor("update")).toContain("--json-progress");
    expect(helpFor("status")).not.toContain("Advanced release/testing options:");
  });
});
