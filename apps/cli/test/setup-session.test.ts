import { describe, expect, test } from "bun:test";
import { createEnvironment, parseEnvironment, replaceEnvironmentValue } from "../src/config";
import {
  createSetupSession,
  type SessionOutcome,
  type SetupSession,
  type SetupSessionInput,
} from "../src/setup-session";
import { SETUP_STAGES, validateOwnerUsername } from "../src/setup-values";
import { renderSetupSession } from "../src/ui";

const PASSWORD = "correct horse battery staple";

const environment = (overrides: Record<string, string> = {}) => {
  let contents = createEnvironment({
    version: "1.2.3",
    workerConcurrency: "8",
  });
  for (const [key, value] of Object.entries(overrides)) {
    contents = replaceEnvironmentValue(contents, key, value);
  }
  return parseEnvironment(contents);
};

const session = (overrides: Partial<SetupSessionInput> = {}): SetupSession => {
  const setup = createSetupSession({
    version: "1.2.3",
    stages: SETUP_STAGES,
    current: environment(),
    fresh: true,
    detectedPrivateHost: "100.100.10.5",
    ...overrides,
  });
  if (!overrides.advanced) setup.handle("", { name: "right" });
  return setup;
};

const press = (target: SetupSession, name: string, extras: Record<string, boolean> = {}) =>
  target.handle("", { name, ...extras });

const type = (target: SetupSession, text: string): SessionOutcome => {
  let outcome: SessionOutcome = { type: "continue" };
  for (const character of text) outcome = target.handle(character, { name: character });
  return outcome;
};

const enter = (target: SetupSession) => press(target, "return");

const highlighted = (target: SetupSession) => {
  const view = target.view();
  const row = view.rows[view.cursorRow];
  return row && "id" in row ? row.id : null;
};

describe("interactive setup session", () => {
  test("fresh setup goes from the reviewed private address and account straight to review", () => {
    const setup = session();

    // There's no default username: setup waits for one, and keeps the case it was typed in.
    expect(highlighted(setup)).toBe("username");
    type(setup, "Sam-Pillai");
    enter(setup);
    enter(setup);
    type(setup, PASSWORD);
    enter(setup);
    type(setup, PASSWORD);
    enter(setup);
    expect(highlighted(setup)).toBe("apply");
    const outcome = enter(setup);
    expect(outcome.type).toBe("complete");
    if (outcome.type !== "complete") return;
    expect(outcome.configuration).toEqual({
      accessMode: "private",
      bindHost: "0.0.0.0",
      viewerBindHost: "0.0.0.0",
      publicHost: "100.100.10.5",
      publicUrl: "http://100.100.10.5:8787",
      composeProfiles: "direct",
      ownerUsername: "Sam-Pillai",
      ownerPassword: PASSWORD,
      apiPort: "8787",
      workerConcurrency: "8",
    });
  });

  test("Esc cancels and Ctrl-C interrupts from navigation", () => {
    expect(press(session(), "escape")).toEqual({ type: "cancel" });
    expect(press(session(), "c", { ctrl: true })).toEqual({ type: "interrupt" });
    const editing = session();
    enter(editing);
    enter(editing);
    expect(editing.view().mode).toBe("edit");
    expect(press(editing, "c", { ctrl: true })).toEqual({ type: "interrupt" });
  });
});

// The server checks the same rules (apps/server/test/auth/username.test.ts).
test("owner usernames keep their case, trim whitespace, and reject unsafe shapes", () => {
  for (const name of ["sam", "Raghav", "raghav-pillai", "Team_Bot.2", "x".repeat(30)])
    expect(validateOwnerUsername(name)).toBe(name);
  expect(validateOwnerUsername("  Raghav-P  ")).toBe("Raghav-P");
  for (const bad of ["", "raghav pillai", "sam@home", "ab", "-sam", "sam.", "sam--bot"])
    expect(() => validateOwnerUsername(bad)).toThrow();
});

const stages = [
  { label: "Access", description: "Choose access." },
  { label: "Owner", description: "Create owner." },
  { label: "Launch", description: "Start services." },
] as const;

describe("setup session frame", () => {
  test("shows the edit buffer, masked secrets, and validation errors", () => {
    const frame = renderSetupSession({
      version: "1.2.3",
      stages,
      activeStage: 1,
      completed: [true, false, false],
      title: "2. Owner",
      description: "Create owner.",
      rows: [
        { kind: "text", id: "username", label: "Username", value: "openteam" },
        {
          kind: "text",
          id: "password",
          label: "Password",
          value: "",
          secret: true,
          editing: {
            buffer: "secret",
            error: "Passwords do not match. Try again.",
            label: "Confirm password",
          },
        },
        { kind: "text", id: "apiKey", label: "API key", value: "hidden-secret", secret: true },
      ],
      cursorRow: 1,
      mode: "edit",
      notice: null,
      color: false,
      width: 72,
    });

    const body = frame.body.join("\n");
    expect(body).toContain("  ❯ Confirm password  ••••••");
    expect(body).not.toContain("secret");
    expect(body).toContain("Passwords do not match. Try again.");
  });
});
