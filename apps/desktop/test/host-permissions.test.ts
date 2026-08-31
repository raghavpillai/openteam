import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeAutoReviewAction,
  authorizeHostAction,
  type HostAction,
} from "../src/main/host-permissions";
import { createPermissionSettingsStore } from "../src/main/permission-settings";

const temporaryDirectories: string[] = [];
const action: HostAction = {
  surface: "hostShell",
  summary: "Run a command",
  target: "/workspace",
  command: "touch report.txt",
};

const store = async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-host-policy-"));
  temporaryDirectories.push(directory);
  return createPermissionSettingsStore(join(directory, "settings.json"));
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("host permission gates", () => {
  test("local denial stops before Auto Review", async () => {
    const settings = await store();
    let reviews = 0;
    const result = await authorizeHostAction(action, {
      settings,
      mode: "enforce",
      promptLocal: async () => "deny",
      review: async () => {
        reviews += 1;
        return { decision: "allow", reason: "safe" };
      },
      promptAutoReview: async () => "allow-once",
    });
    expect(result).toMatchObject({ allowed: false, gate: "local" });
    expect(reviews).toBe(0);
  });

  test("standing local allow still runs Auto Review", async () => {
    const settings = await store();
    await settings.update({ localToolPermission: "always" });
    const result = await authorizeHostAction(action, {
      settings,
      mode: "enforce",
      promptLocal: async () => {
        throw new Error("standing local allowance should skip the local prompt");
      },
      review: async () => ({ decision: "block", reason: "writes a file" }),
      promptAutoReview: async () => "deny",
    });
    expect(result).toMatchObject({ allowed: false, gate: "auto-review" });
  });

  test("Always on an Auto Review card saves a narrow rule but only after the local gate", async () => {
    const settings = await store();
    const result = await authorizeHostAction(action, {
      settings,
      mode: "enforce",
      promptLocal: async () => "allow-once",
      review: async () => ({
        decision: "block",
        reason: "no matching rule",
        proposedRule: "Allow creating report.txt in /workspace",
      }),
      promptAutoReview: async () => "always",
    });
    expect(result.allowed).toBe(true);
    expect((await settings.read()).autoReview.allowInstructions).toEqual([
      "Allow creating report.txt in /workspace",
    ]);
    expect((await settings.read()).localToolPermission).toBe("ask");
  });

  test("reviewer rejection and reviewer failure both fail closed", async () => {
    const settings = await store();
    await settings.update({ localToolPermission: "always" });
    const rejected = await authorizeHostAction(action, {
      settings,
      mode: "enforce",
      promptLocal: async () => "deny",
      review: async () => ({ decision: "reject", reason: "invalid model output" }),
      promptAutoReview: async () => "allow-once",
    });
    const failed = await authorizeHostAction(action, {
      settings,
      mode: "enforce",
      promptLocal: async () => "deny",
      review: async () => {
        throw new Error("review service offline");
      },
      promptAutoReview: async () => "allow-once",
    });
    expect(rejected).toMatchObject({ allowed: false, gate: "auto-review" });
    expect(failed).toMatchObject({ allowed: false, gate: "auto-review" });
  });

  test("shadow mode observes without blocking", async () => {
    const settings = await store();
    await settings.update({ localToolPermission: "always" });
    const result = await authorizeHostAction(action, {
      settings,
      mode: "shadow",
      promptLocal: async () => "deny",
      review: async () => ({ decision: "block", reason: "would block in enforce" }),
      promptAutoReview: async () => "deny",
    });
    expect(result.allowed).toBe(true);
  });

  test("Task Auto-review skips the local-computer gate but keeps Ask-first rules", async () => {
    const settings = await store();
    let localPrompts = 0;
    const result = await authorizeAutoReviewAction(
      {
        surface: "subagentLaunch",
        summary: "Run a browser task",
        target: "browserUse",
        arguments: { prompt: "Open example.com" },
      },
      {
        settings,
        mode: "enforce",
        promptLocal: async () => {
          localPrompts += 1;
          return "deny";
        },
        review: async () => ({ decision: "block", reason: "browser rule requires approval" }),
        promptAutoReview: async () => "deny",
      }
    );
    expect(result).toMatchObject({ allowed: false, gate: "auto-review" });
    expect(localPrompts).toBe(0);
  });
});
