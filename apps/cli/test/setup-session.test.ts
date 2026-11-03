import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
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
  test("left and right move between sections while up and down move the highlight", () => {
    const setup = session();
    expect(setup.view().activeStage).toBe(1);
    expect(setup.view().title).toBe("2. Account");
    expect(highlighted(setup)).toBe("username");
    expect(rowIds(setup).some((id) => id.startsWith("access:"))).toBe(false);

    press(setup, "right");
    expect(setup.view().activeStage).toBe(2);
    expect(setup.view().title).toBe("3. Review");

    press(setup, "right");
    expect(setup.view().activeStage).toBe(2);

    press(setup, "left");
    press(setup, "left");
    expect(setup.view().activeStage).toBe(0);
    expect(highlighted(setup)).toBe("access:private");
    expect(setup.view().stages.map((stage) => stage.label)).toEqual([
      "Connection",
      "Account",
      "Review",
      "Checks",
    ]);
  });

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

  test("validates text fields inline and lets Esc discard an edit", () => {
    const setup = session({ advanced: true });
    type(setup, "3");
    edit(setup, "203.0.113.9");
    expect(setup.view().mode).toBe("edit");
    expect(setup.view().rows.find((row) => row.kind === "text" && row.id === "host")).toMatchObject(
      {
        editing: { error: "Enter a public domain name, such as bot.example.com." },
      }
    );

    press(setup, "right");
    expect(setup.view().activeStage).toBe(0);
    press(setup, "escape");
    expect(setup.view().mode).toBe("navigate");
    expect(setup.state.host).toBe("");
  });

  test("typing replaces the highlighted field without an extra Enter", () => {
    const setup = session({ advanced: true, detectedPrivateHost: null });
    enter(setup);
    expect(highlighted(setup)).toBe("host");

    type(setup, "192.168.1.20");
    expect(setup.view().mode).toBe("edit");
    expect(setup.view().rows.find((row) => row.kind === "text" && row.id === "host")).toMatchObject(
      { editing: { buffer: "192.168.1.20" } }
    );

    enter(setup);
    expect(setup.state.host).toBe("192.168.1.20");
    // Advanced setup continues to the server settings below the address.
    expect(highlighted(setup)).toBe("apiPort");
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

  test("private mode prefills the detected address and keeps viewers on the LAN", () => {
    const setup = session({ detectedPrivateHost: "100.100.10.5", ownerConfigured: true });
    expect(setup.view().title).toBe("2. Account");
    expect(setup.view().stages.map((stage) => stage.label)).toEqual([
      "Connection",
      "Account",
      "Review",
      "Checks",
    ]);
    expect(setup.state.host).toBe("100.100.10.5");
    expect(setup.problems()).toEqual([]);
    expect(setup.configuration()).toMatchObject({
      accessMode: "private",
      bindHost: "0.0.0.0",
      viewerBindHost: "0.0.0.0",
      publicHost: "100.100.10.5",
      publicUrl: "http://100.100.10.5:8787",
      ownerPassword: undefined,
    });
  });

  test("an existing account says it's kept, and Enter moves on", () => {
    const setup = session({ detectedPrivateHost: "100.100.10.5", ownerConfigured: true });
    expect(setup.view().title).toBe("2. Account");
    expect(setup.view().description).toBe("Keep the account you already sign in with.");
    enter(setup);
    expect(setup.view().title).toBe("3. Review");
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

  test("advanced mode adds server settings to Connection with validation", () => {
    const setup = session({ advanced: true, ownerConfigured: true });
    type(setup, "2");
    expect(setup.state.accessMode).toBe("local");
    expect(rowIds(setup).slice(-2)).toEqual(["apiPort", "workerConcurrency"]);
    expect(highlighted(setup)).toBe("apiPort");
    edit(setup, "invalid");
    expect(
      setup.view().rows.find((row) => row.kind === "text" && row.id === "apiPort")
    ).toMatchObject({
      editing: { error: "API port must be a whole number." },
    });
    press(setup, "u", { ctrl: true });
    type(setup, "9444");
    enter(setup);
    expect(highlighted(setup)).toBe("workerConcurrency");
    edit(setup, "4");
    expect(setup.view().title).toBe("2. Account");

    press(setup, "right");
    expect(setup.rows()).toContainEqual({ kind: "field", label: "Tasks at once", value: "4" });
    expect(setup.configuration()).toMatchObject({
      accessMode: "local",
      publicUrl: "http://127.0.0.1:9444",
      apiPort: "9444",
      workerConcurrency: "4",
    });
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

  test("Enter keeps a saved password after a failed startup check or going back from review", () => {
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

    // Back from review: the cursor is on the saved password, and Enter keeps it.
    press(setup, "left");
    expect(highlighted(setup)).toBe("password");
    enter(setup);
    expect(setup.view().notice).toBeNull();
    expect(setup.view().title).toBe("3. Review");

    // A busy port reopens Connection with the API port; Enter keeps each answer up to Account.
    setup.returnWithIssue("OpenTeam cannot start because port 8787 is already in use.");
    enter(setup);
    enter(setup);
    expect(highlighted(setup)).toBe("apiPort");
    enter(setup);
    expect(setup.view().title).toBe("2. Account");
    expect(highlighted(setup)).toBe("password");
    enter(setup);
    expect(setup.view().notice).toBeNull();
    expect(highlighted(setup)).toBe("apply");
    expect(setup.configuration().ownerPassword).toBe(PASSWORD);
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

  test("launch notes surface port fallbacks and the cancel action ends without changes", () => {
    const setup = session({
      current: environment({ OPENTEAM_API_PORT: "8788" }),
      notes: [{ text: "Port 8787 is already in use; using 8788.", tone: "info" }],
    });
    press(setup, "right");
    expect(setup.rows()).toContainEqual({
      kind: "note",
      text: "Port 8787 is already in use; using 8788.",
      tone: "info",
    });
    expect(setup.rows()).not.toContainEqual({ kind: "field", label: "API port", value: "8788" });
    press(setup, "down");
    expect(highlighted(setup)).toBe("cancel");
    expect(enter(setup)).toEqual({ type: "cancel" });
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

const python = Bun.which("python3");
describe.skipIf(process.platform === "win32" || !python)("setup terminal startup checks", () => {
  test("a busy port reopens Connection, and fixing it starts with the same answers", async () => {
    const child = Bun.spawn(
      [
        python!,
        resolve(import.meta.dir, "fixtures/interactive-pty.py"),
        JSON.stringify({
          columns: 90,
          rows: 40,
          steps: [
            { expect: "OPENTEAM" },
            { send: "\x1b[C", expect: "existing account" },
            { send: "\x1b[C", expect: "Start OpenTeam" },
            { send: "\r", expect: "already in use" },
            { send: "\x1b[F8788\r", expect: "2. Account" },
            { send: "\x1b[C", expect: "8788" },
            { send: "\r", expect: "Applied" },
          ],
        }),
        process.execPath,
        resolve(import.meta.dir, "fixtures/setup-check-pty.ts"),
      ],
      {
        env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (error) console.error(error, stripVTControlCharacters(output).slice(-2000));
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(stripVTControlCharacters(output)).toContain(
      'Applied {"attempts":["8787","8788"],"apiPort":"8788"}'
    );
    expect(output).toContain("\x1b[?25h");
  }, 15000);

  test("Ctrl-C in the questions cancels without changes, like Esc", async () => {
    const child = Bun.spawn(
      [
        python!,
        resolve(import.meta.dir, "fixtures/interactive-pty.py"),
        JSON.stringify({
          columns: 90,
          rows: 40,
          steps: [{ expect: "OPENTEAM" }, { send: "\x03", expect: "Applied" }],
        }),
        process.execPath,
        resolve(import.meta.dir, "fixtures/setup-check-pty.ts"),
      ],
      {
        env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (error) console.error(error, stripVTControlCharacters(output).slice(-2000));
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(stripVTControlCharacters(output)).toContain('Applied {"attempts":[]}');
  }, 15000);
});
