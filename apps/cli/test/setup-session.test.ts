import { describe, expect, test } from "bun:test";
import { createEnvironment, parseEnvironment, replaceEnvironmentValue } from "../src/config";
import {
  createSetupSession,
  type SessionOutcome,
  type SetupSession,
  type SetupSessionInput,
} from "../src/setup-session";
import { SETUP_STAGES } from "../src/setup-values";

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
    expect(setup.problems().map((problem) => problem.rowId)).toEqual(["username", "password"]);
    type(setup, "Sam-Pillai");
    enter(setup);
    expect(highlighted(setup)).toBe("password");
    enter(setup);
    type(setup, PASSWORD);
    enter(setup);
    expect(
      setup.view().rows.find((row) => row.kind === "text" && row.id === "password")
    ).toMatchObject({ editing: { buffer: "", label: "Confirm password" } });
    type(setup, PASSWORD);
    enter(setup);
    expect(setup.view().mode).toBe("navigate");
    expect(setup.view().activeStage).toBe(2);
    expect(setup.view().completed).toEqual([true, true, false, false]);
    expect(highlighted(setup)).toBe("apply");
    expect(setup.view().rows).toContainEqual({
      kind: "field",
      label: "Address",
      value: "http://100.100.10.5:8787",
    });
    expect(
      setup.view().rows.some((row) => row.kind === "field" && row.label === "Connection")
    ).toBe(true);
    expect(
      setup.view().rows.some((row) => "label" in row && /inference|model/i.test(row.label))
    ).toBe(false);

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
