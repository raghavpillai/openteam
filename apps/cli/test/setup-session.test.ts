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
  let contents = createEnvironment({ version: "1.2.3", timeZone: "UTC" });
  for (const [key, value] of Object.entries(overrides)) {
    contents = replaceEnvironmentValue(contents, key, value);
  }
  return parseEnvironment(contents);
};

const session = (overrides: Partial<SetupSessionInput> = {}): SetupSession =>
  createSetupSession({
    version: "1.2.3",
    stages: SETUP_STAGES,
    current: environment(),
    authenticated: false,
    fresh: true,
    ...overrides,
  });

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

const textRow = (target: SetupSession, id: string) =>
  target.view().rows.find((row) => row.kind === "text" && row.id === id);

const edit = (target: SetupSession, value: string) => {
  enter(target);
  expect(target.view().mode).toBe("edit");
  press(target, "u", { ctrl: true });
  type(target, value);
  return enter(target);
};

describe("interactive setup session", () => {
  test("left and right move between sections while up and down move the highlight", () => {
    const setup = session();
    expect(setup.view().activeStage).toBe(0);
    expect(setup.view().title).toBe("1. Access");
    expect(highlighted(setup)).toBe("access:local");

    press(setup, "down");
    expect(highlighted(setup)).toBe("access:https");
    press(setup, "up");
    press(setup, "up");
    expect(highlighted(setup)).toBe("access:private");

    press(setup, "right");
    expect(setup.view().activeStage).toBe(1);
    expect(setup.view().title).toBe("2. Owner");
    expect(highlighted(setup)).toBe("username");

    press(setup, "right");
    press(setup, "right");
    press(setup, "right");
    expect(setup.view().activeStage).toBe(3);
    expect(setup.view().title).toBe("4. Review");

    press(setup, "left");
    press(setup, "left");
    press(setup, "left");
    press(setup, "left");
    expect(setup.view().activeStage).toBe(0);
    expect(highlighted(setup)).toBe("access:private");
    expect(setup.view().stages.map((stage) => stage.label)).toEqual([
      "Access",
      "Owner",
      "Runtime",
      "Review",
    ]);
  });

  test("recommends the detected private network and otherwise this machine only", () => {
    const detected = session({ detectedPrivateHost: "100.100.10.5" });
    expect(detected.state).toMatchObject({ accessMode: "private", host: "100.100.10.5" });
    expect(highlighted(detected)).toBe("access:private");
    expect(
      detected.rows().find((row) => row.kind === "option" && row.id === "access:private")
    ).toMatchObject({ selected: true, recommended: true });
    expect(detected.rows().filter((row) => row.kind === "option" && row.recommended)).toHaveLength(
      1
    );

    const loopback = session({ detectedPrivateHost: null });
    expect(loopback.state).toMatchObject({ accessMode: "local", host: "" });
    expect(
      loopback.rows().find((row) => row.kind === "option" && row.id === "access:local")
    ).toMatchObject({ selected: true, recommended: true });
    expect(rowIds(loopback)).toEqual([
      "access:private",
      "access:local",
      "access:https",
      "access:proxy",
      "access:http",
    ]);
  });

  test("finishing a section moves to the next one, and Review waits for Apply", () => {
    const setup = session();

    expect(type(setup, "3")).toEqual({ type: "continue" });
    expect(setup.state.accessMode).toBe("https");
    expect(setup.view().activeStage).toBe(0);
    expect(highlighted(setup)).toBe("host");
    expect(edit(setup, "bot.example.com")).toEqual({ type: "continue" });
    expect(setup.view().mode).toBe("navigate");
    expect(setup.view().activeStage).toBe(1);
    expect(highlighted(setup)).toBe("username");
    expect(setup.view().completed).toEqual([true, false, true, false]);

    enter(setup);
    expect(textRow(setup, "username")).toMatchObject({
      editing: { buffer: "openteam", error: null },
    });
    enter(setup);
    expect(setup.view().activeStage).toBe(1);
    expect(highlighted(setup)).toBe("password");
    enter(setup);
    type(setup, PASSWORD);
    enter(setup);
    expect(textRow(setup, "password")).toMatchObject({
      editing: { buffer: "", label: "Confirm password" },
    });
    type(setup, PASSWORD);
    enter(setup);
    expect(setup.view().mode).toBe("navigate");
    expect(setup.view().activeStage).toBe(2);
    expect(highlighted(setup)).toBe("provider:openai-codex");
    expect(setup.view().completed).toEqual([true, true, true, false]);

    type(setup, "1");
    expect(setup.view().activeStage).toBe(3);
    expect(highlighted(setup)).toBe("apply");
    expect(setup.view().rows).toContainEqual({
      kind: "field",
      label: "Address",
      value: "https://bot.example.com",
    });

    const outcome = enter(setup);
    expect(outcome.type).toBe("complete");
    if (outcome.type !== "complete") return;
    expect(outcome.configuration).toEqual({
      accessMode: "https",
      bindHost: "127.0.0.1",
      viewerBindHost: "127.0.0.1",
      publicHost: "127.0.0.1",
      publicUrl: "https://bot.example.com",
      composeProfiles: "https",
      ownerUsername: "openteam",
      ownerPassword: PASSWORD,
      apiPort: "8787",
      timeZone: "UTC",
      provider: "openai-codex",
      model: "gpt-5.5",
      thinking: "high",
      workerConcurrency: "8",
      authenticate: true,
      authType: "oauth",
    });
  });

  test("applying with missing fields jumps to the first problem instead of completing", () => {
    const setup = session();
    press(setup, "right");
    press(setup, "right");
    press(setup, "right");
    expect(
      setup.rows().filter((row) => row.kind === "note" && row.tone === "warning")
    ).toHaveLength(1);

    expect(enter(setup)).toEqual({ type: "continue" });
    expect(setup.view().activeStage).toBe(1);
    expect(highlighted(setup)).toBe("password");
    expect(setup.view().notice).toEqual({
      text: "Set the owner password in Owner.",
      tone: "warning",
    });
    expect(() => setup.configuration()).toThrow("Set the owner password");
  });

  test("validates text fields inline and lets Esc discard an edit", () => {
    const setup = session();
    type(setup, "3");
    edit(setup, "203.0.113.9");
    expect(setup.view().mode).toBe("edit");
    expect(textRow(setup, "host")).toMatchObject({
      editing: { error: "Enter a public domain name, such as bot.example.com." },
    });

    press(setup, "right");
    expect(setup.view().activeStage).toBe(0);
    press(setup, "escape");
    expect(setup.view().mode).toBe("navigate");
    expect(setup.state.host).toBe("");
  });

  test("public HTTP needs a host and an explicit acknowledgement", () => {
    const setup = session();
    type(setup, "5");
    expect(setup.state.accessMode).toBe("http");
    expect(highlighted(setup)).toBe("host");
    expect(rowIds(setup)).toEqual([
      "access:private",
      "access:local",
      "access:https",
      "access:proxy",
      "access:http",
      "host",
      "httpAck",
    ]);
    edit(setup, "203.0.113.9");
    expect(setup.view().activeStage).toBe(0);
    expect(setup.problems().map((problem) => problem.rowId)).toEqual(["httpAck", "password"]);

    expect(highlighted(setup)).toBe("httpAck");
    press(setup, "space");
    expect(setup.state.httpAcknowledged).toBe(true);
    expect(setup.view().activeStage).toBe(1);
    expect(setup.problems().map((problem) => problem.rowId)).toEqual(["password"]);
  });

  test("a stored private address never prefills the public domain field", () => {
    const setup = session({
      current: environment({ OPENTEAM_PUBLIC_HOST: "100.113.180.21" }),
      ownerConfigured: true,
      detectedPrivateHost: null,
    });
    expect(setup.state.accessMode).toBe("local");
    expect(setup.state.host).toBe("");
    type(setup, "3");
    expect(setup.state.host).toBe("");
    expect(setup.view().activeStage).toBe(0);
    type(setup, "1");
    expect(setup.state.host).toBe("100.113.180.21");
    expect(setup.view().activeStage).toBe(2);
    press(setup, "left");
    press(setup, "left");
    type(setup, "3");
    expect(setup.state.host).toBe("100.113.180.21");
    expect(setup.problems()[0]?.message).toContain("Enter a public domain name");
  });

  test("private mode prefills the detected address and skips a configured owner", () => {
    const setup = session({ detectedPrivateHost: "100.100.10.5", ownerConfigured: true });
    expect(setup.state.accessMode).toBe("private");
    type(setup, "1");
    expect(setup.state.host).toBe("100.100.10.5");
    expect(setup.view().activeStage).toBe(2);
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

  test("password confirmation mismatches restart the entry with an error", () => {
    const setup = session();
    press(setup, "right");
    press(setup, "down");
    enter(setup);
    type(setup, "short");
    enter(setup);
    expect(textRow(setup, "password")).toMatchObject({
      editing: { error: "Password must be between 8 and 128 characters." },
    });
    press(setup, "u", { ctrl: true });
    type(setup, PASSWORD);
    enter(setup);
    type(setup, "something else entirely");
    enter(setup);
    expect(textRow(setup, "password")).toMatchObject({
      editing: { buffer: "", error: "Passwords do not match. Try again." },
    });
    expect(setup.state.ownerPassword).toBeNull();
    type(setup, PASSWORD);
    enter(setup);
    type(setup, PASSWORD);
    enter(setup);
    expect(setup.state.ownerPassword).toBe(PASSWORD);
    expect(setup.view().mode).toBe("navigate");
    expect(setup.view().activeStage).toBe(2);
  });

  test("provider options carry the sign-in method and reset the model, defaults, and key", () => {
    const setup = session({ authenticated: true, ownerConfigured: true });
    type(setup, "2");
    expect(setup.view().activeStage).toBe(2);
    expect(setup.state.authenticate).toBe(false);
    expect(
      setup.rows().find((row) => row.kind === "toggle" && row.id === "authenticate")
    ).toMatchObject({ label: "Configure openai-codex authentication again", checked: false });
    expect(rowIds(setup)).toEqual([
      "provider:openai-codex",
      "provider:anthropic",
      "provider:anthropic-key",
      "provider:openai",
      "provider:custom",
      "model",
      "authenticate",
    ]);

    type(setup, "3");
    expect(setup.state).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      authenticate: true,
      authType: "api_key",
      apiKey: null,
    });
    expect(setup.view().activeStage).toBe(2);
    expect(highlighted(setup)).toBe("apiKey");
    expect(setup.problems().map((problem) => problem.message)).toEqual([
      "Enter the anthropic API key or password in Runtime.",
    ]);
    edit(setup, "anthropic-test-secret");
    expect(setup.view().activeStage).toBe(3);
    expect(setup.configuration()).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      authenticate: true,
      authType: "api_key",
      apiKey: "anthropic-test-secret",
    });

    press(setup, "left");
    type(setup, "2");
    expect(setup.state).toMatchObject({
      provider: "anthropic",
      authenticate: true,
      authType: "oauth",
      apiKey: null,
    });
    expect(setup.view().activeStage).toBe(3);

    press(setup, "left");
    type(setup, "4");
    expect(setup.state).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      authType: "api_key",
    });
    expect(setup.view().activeStage).toBe(2);
    expect(highlighted(setup)).toBe("apiKey");

    type(setup, "1");
    expect(setup.state).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      authenticate: false,
      authType: "oauth",
    });
    expect(setup.view().activeStage).toBe(3);
  });

  test("preselects a detected sign-in and marks it for reuse", () => {
    const claude = { provider: "anthropic" as const, source: "Claude Code (macOS Keychain)" };
    const setup = session({ detectedLogins: [claude], ownerConfigured: true });
    expect(setup.state).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      authenticate: true,
      authType: "oauth",
    });
    type(setup, "2");
    expect(setup.view().activeStage).toBe(2);
    expect(highlighted(setup)).toBe("provider:anthropic");
    expect(
      setup.rows().find((row) => row.kind === "option" && row.id === "provider:anthropic")
    ).toMatchObject({
      selected: true,
      recommended: true,
      badge: "detected",
      description: "Reuses your Claude Code (macOS Keychain) sign-in; no browser login needed.",
    });
    expect(
      setup.rows().find((row) => row.kind === "option" && row.id === "provider:openai-codex")
    ).not.toMatchObject({ recommended: true });
    expect(setup.configuration().reuseLogin).toEqual(claude);

    enter(setup);
    expect(setup.view().activeStage).toBe(3);
    expect(setup.rows()).toContainEqual({
      kind: "field",
      label: "Sign-in",
      value: "reuse Claude Code (macOS Keychain)",
    });

    press(setup, "left");
    type(setup, "3");
    expect(highlighted(setup)).toBe("apiKey");
    edit(setup, "anthropic-test-secret");
    expect(setup.view().activeStage).toBe(3);
    expect(setup.configuration().reuseLogin).toBeUndefined();
    expect(setup.rows()).toContainEqual({ kind: "field", label: "Sign-in", value: "API key" });

    const authenticated = session({
      detectedLogins: [claude],
      ownerConfigured: true,
      authenticated: true,
    });
    expect(authenticated.state).toMatchObject({ provider: "openai-codex", authenticate: false });
    expect(authenticated.configuration().reuseLogin).toBeUndefined();
  });

  test("custom providers collect every field, cycle the API, and register on apply", () => {
    const setup = session({ ownerConfigured: true });
    type(setup, "2");
    type(setup, "5");
    expect(setup.state.provider).toBe("custom");
    expect(setup.view().activeStage).toBe(2);
    expect(highlighted(setup)).toBe("custom.baseUrl");
    expect(rowIds(setup)).toEqual([
      "provider:openai-codex",
      "provider:anthropic",
      "provider:anthropic-key",
      "provider:openai",
      "provider:custom",
      "custom.id",
      "custom.name",
      "custom.baseUrl",
      "custom.api",
      "custom.model",
      "custom.reasoning",
      "authenticate",
      "apiKey",
    ]);

    press(setup, "up");
    press(setup, "up");
    expect(highlighted(setup)).toBe("custom.id");
    edit(setup, "BAD ID");
    expect(setup.view().mode).toBe("edit");
    press(setup, "u", { ctrl: true });
    type(setup, "acme");
    enter(setup);
    expect(highlighted(setup)).toBe("custom.baseUrl");
    press(setup, "up");
    edit(setup, "Acme AI");
    expect(highlighted(setup)).toBe("custom.baseUrl");
    edit(setup, "ftp://api.example.com");
    expect(setup.view().mode).toBe("edit");
    press(setup, "u", { ctrl: true });
    type(setup, "https://api.example.com/v1/");
    enter(setup);
    expect(highlighted(setup)).toBe("custom.model");
    press(setup, "up");
    enter(setup);
    enter(setup);
    enter(setup);
    expect(setup.state.custom.api).toBe("google-generative-ai");
    press(setup, "down");
    edit(setup, "gemini-2.5-pro");
    expect(highlighted(setup)).toBe("apiKey");
    press(setup, "up");
    press(setup, "up");
    expect(highlighted(setup)).toBe("custom.reasoning");
    enter(setup);
    press(setup, "down");
    press(setup, "down");
    edit(setup, "generic-provider-password");
    expect(setup.view().activeStage).toBe(3);

    expect(setup.problems()).toEqual([]);
    expect(setup.configuration()).toMatchObject({
      provider: "acme",
      model: "gemini-2.5-pro",
      authenticate: true,
      authType: "api_key",
      apiKey: "generic-provider-password",
      customProvider: {
        id: "acme",
        name: "Acme AI",
        baseUrl: "https://api.example.com/v1",
        api: "google-generative-ai",
        model: "gemini-2.5-pro",
        reasoning: false,
      },
    });
  });

  test("advanced mode exposes server settings with validation", () => {
    const setup = session({ advanced: true, ownerConfigured: true });
    type(setup, "2");
    expect(setup.view().activeStage).toBe(2);
    expect(rowIds(setup).slice(0, 2)).toEqual(["apiPort", "timeZone"]);
    expect(highlighted(setup)).toBe("provider:openai-codex");
    press(setup, "home");
    expect(highlighted(setup)).toBe("apiPort");
    edit(setup, "invalid");
    expect(textRow(setup, "apiPort")).toMatchObject({
      editing: { error: "API port must be a whole number." },
    });
    press(setup, "u", { ctrl: true });
    type(setup, "9444");
    enter(setup);
    expect(highlighted(setup)).toBe("timeZone");
    edit(setup, "Europe/London");
    expect(highlighted(setup)).toBe("provider:openai-codex");
    expect(rowIds(setup)).toContain("thinking");
    expect(rowIds(setup)).toContain("workerConcurrency");
    press(setup, "end");
    expect(highlighted(setup)).toBe("authenticate");
    press(setup, "up");
    edit(setup, "4");
    expect(highlighted(setup)).toBe("authenticate");
    press(setup, "up");
    press(setup, "up");
    expect(highlighted(setup)).toBe("thinking");
    enter(setup);
    expect(setup.state.thinking).toBe("xhigh");
    expect(setup.view().activeStage).toBe(2);

    expect(setup.configuration()).toMatchObject({
      accessMode: "local",
      publicUrl: "http://127.0.0.1:9444",
      apiPort: "9444",
      timeZone: "Europe/London",
      thinking: "xhigh",
      workerConcurrency: "4",
    });
  });

  test("reconfiguration keeps an existing owner and custom provider", () => {
    const setup = session({
      current: environment({ OPENTEAM_ACCESS_MODE: "local", OPENTEAM_BIND_HOST: "127.0.0.1" }),
      fresh: false,
      authenticated: true,
      ownerConfigured: true,
      currentOwnerUsername: "existing.owner",
      currentInference: { providerId: "acme", modelId: "acme-chat", reasoning: "high" },
    });
    expect(highlighted(setup)).toBe("access:local");
    press(setup, "right");
    expect(setup.view().cursorRow).toBe(-1);
    expect(setup.rows().map((row) => row.kind)).toEqual(["note"]);
    press(setup, "right");
    expect(highlighted(setup)).toBe("provider:acme");
    expect(
      setup.rows().find((row) => row.kind === "option" && row.id === "provider:acme")
    ).toMatchObject({ label: "Keep existing provider (acme)", selected: true, recommended: true });
    expect(setup.view().completed).toEqual([true, true, true, false]);
    expect(setup.configuration()).toMatchObject({
      accessMode: "local",
      ownerUsername: "existing.owner",
      ownerPassword: undefined,
      provider: "acme",
      model: "acme-chat",
      authenticate: false,
      customProvider: undefined,
    });
  });

  test("review notes surface port fallbacks and the cancel action ends without changes", () => {
    const setup = session({
      current: environment({ OPENTEAM_API_PORT: "8788" }),
      notes: [{ text: "Port 8787 is already in use; using 8788.", tone: "info" }],
    });
    press(setup, "right");
    press(setup, "right");
    press(setup, "right");
    expect(setup.rows()).toContainEqual({
      kind: "note",
      text: "Port 8787 is already in use; using 8788.",
      tone: "info",
    });
    expect(setup.rows()).toContainEqual({ kind: "field", label: "API port", value: "8788" });
    press(setup, "down");
    expect(highlighted(setup)).toBe("cancel");
    expect(enter(setup)).toEqual({ type: "cancel" });
  });

  test("Esc cancels and Ctrl-C interrupts from navigation", () => {
    expect(press(session(), "escape")).toEqual({ type: "cancel" });
    expect(press(session(), "c", { ctrl: true })).toEqual({ type: "interrupt" });
    const editing = session();
    type(editing, "3");
    enter(editing);
    expect(editing.view().mode).toBe("edit");
    expect(press(editing, "c", { ctrl: true })).toEqual({ type: "interrupt" });
  });
});
