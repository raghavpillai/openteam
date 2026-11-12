import { describe, expect, test } from "bun:test";
import { createEnvironment, parseEnvironment, replaceEnvironmentValue } from "../src/config";
import {
  createSetupSession,
  type SessionOutcome,
  type SetupSession,
  type SetupSessionInput,
} from "../src/setup-session";
import { SETUP_STAGES } from "../src/setup-values";
import { SELECTABLE_ROW_KINDS } from "../src/ui";

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

const rowIds = (target: SetupSession) =>
  target
    .rows()
    .filter((row) => SELECTABLE_ROW_KINDS.has(row.kind))
    .map((row) => ("id" in row ? row.id : row.kind));

const edit = (target: SetupSession, value: string) => {
  type(target, value);
  expect(target.view().mode).toBe("edit");
  return enter(target);
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

  test("applying with missing fields jumps to the first problem instead of completing", () => {
    const setup = session();
    press(setup, "right");
    expect(
      setup.rows().filter((row) => row.kind === "note" && row.tone === "warning")
    ).toHaveLength(2);

    expect(enter(setup)).toEqual({ type: "continue" });
    expect(setup.view().activeStage).toBe(1);
    expect(highlighted(setup)).toBe("username");
    expect(setup.view().notice).toEqual({
      text: "Choose a username in Account.",
      tone: "warning",
    });
    expect(() => setup.configuration()).toThrow("Choose a username");
  });

  test("public HTTP needs a host and an explicit acknowledgement", () => {
    const setup = session({ advanced: true });
    type(setup, "5");
    expect(setup.state.accessMode).toBe("http");
    expect(highlighted(setup)).toBe("host");
    expect(rowIds(setup)).toEqual([
      "access:private",
      "access:local",
      "access:https",
      "access:proxy",
      "access:http",
      "access:tailscale",
      "host",
      "httpAck",
      "apiPort",
      "workerConcurrency",
    ]);
    edit(setup, "203.0.113.9");
    expect(setup.problems().map((problem) => problem.rowId)).toEqual([
      "httpAck",
      "username",
      "password",
    ]);

    expect(highlighted(setup)).toBe("httpAck");
    press(setup, "space");
    expect(setup.state.httpAcknowledged).toBe(true);
    expect(setup.problems().map((problem) => problem.rowId)).toEqual(["username", "password"]);
  });

  test("password confirmation mismatches restart the entry with an error", () => {
    const setup = session();
    press(setup, "down");
    enter(setup);
    type(setup, "short");
    enter(setup);
    expect(
      setup.view().rows.find((row) => row.kind === "text" && row.id === "password")
    ).toMatchObject({
      editing: { error: "Password must be between 8 and 128 characters." },
    });
    press(setup, "u", { ctrl: true });
    type(setup, PASSWORD);
    enter(setup);
    type(setup, "something else entirely");
    enter(setup);
    expect(
      setup.view().rows.find((row) => row.kind === "text" && row.id === "password")
    ).toMatchObject({
      editing: { buffer: "", error: "Passwords do not match. Try again." },
    });
    expect(setup.state.ownerPassword).toBeNull();
    type(setup, PASSWORD);
    enter(setup);
    type(setup, PASSWORD);
    enter(setup);
    expect(setup.state.ownerPassword).toBe(PASSWORD);
    expect(setup.view().mode).toBe("navigate");
  });

  test("a failed startup check reopens Connection with the answers and the API port", () => {
    const setup = session();
    enter(setup);
    type(setup, "sam");
    enter(setup);
    enter(setup);
    type(setup, PASSWORD);
    enter(setup);
    type(setup, PASSWORD);
    enter(setup);
    expect(highlighted(setup)).toBe("apply");
    expect(
      rowIds(createSetupSession({ version: "1", stages: SETUP_STAGES, current: environment() }))
    ).not.toContain("apiPort");

    setup.checking();
    expect(setup.view().notice).toEqual({ text: "Checking startup ports…", tone: "info" });
    setup.returnWithIssue("OpenTeam cannot start because port 8787 is already in use.");
    expect(setup.view().title).toBe("1. Connection");
    expect(highlighted(setup)).toBe("access:private");
    expect(setup.rows()[0]).toEqual({
      kind: "note",
      text: "OpenTeam cannot start because port 8787 is already in use.",
      tone: "warning",
    });
    press(setup, "end");
    expect(highlighted(setup)).toBe("apiPort");
    press(setup, "u", { ctrl: true });
    edit(setup, "8788");
    expect(setup.state.ownerPassword).toBe(PASSWORD);
    expect(setup.configuration()).toMatchObject({
      publicUrl: "http://100.100.10.5:8788",
      apiPort: "8788",
      ownerPassword: PASSWORD,
    });
  });

  test("reconfiguration keeps an existing owner and asks nothing about models", () => {
    const setup = session({
      current: environment({ OPENTEAM_ACCESS_MODE: "local", OPENTEAM_BIND_HOST: "127.0.0.1" }),
      fresh: false,
      ownerConfigured: true,
      currentOwnerUsername: "existing.owner",
    });
    expect(setup.view().title).toBe("2. Account");
    expect(setup.view().cursorRow).toBe(-1);
    expect(setup.rows().map((row) => row.kind)).toEqual(["note", "note"]);
    press(setup, "right");
    expect(setup.view().title).toBe("3. Review");
    expect(setup.view().completed).toEqual([true, true, false, false]);
    expect(setup.configuration()).toEqual({
      accessMode: "local",
      bindHost: "127.0.0.1",
      viewerBindHost: "127.0.0.1",
      publicHost: "127.0.0.1",
      publicUrl: "http://127.0.0.1:8787",
      composeProfiles: "direct",
      ownerUsername: "existing.owner",
      ownerPassword: undefined,
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
