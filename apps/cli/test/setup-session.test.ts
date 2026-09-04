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
    timeZone: "UTC",
    workerConcurrency: "8",
  });
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
    detectedPrivateHost: "100.100.10.5",
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

const edit = (target: SetupSession, value: string) => {
  type(target, value);
  expect(target.view().mode).toBe("edit");
  return enter(target);
};

describe("interactive setup session", () => {
  test("left and right move between sections while up and down move the highlight", () => {
    const setup = session();
    expect(setup.view().activeStage).toBe(0);
    expect(setup.view().title).toBe("1. Account");
    expect(highlighted(setup)).toBe("username");
    expect(rowIds(setup).some((id) => id.startsWith("access:"))).toBe(false);

    press(setup, "right");
    expect(setup.view().activeStage).toBe(1);
    expect(setup.view().title).toBe("2. Inference");
    expect(highlighted(setup)).toBe("provider:openai-codex");

    press(setup, "right");
    expect(setup.view().activeStage).toBe(2);
    expect(setup.view().title).toBe("3. Review");

    press(setup, "left");
    press(setup, "left");
    press(setup, "left");
    expect(setup.view().activeStage).toBe(0);
    expect(highlighted(setup)).toBe("username");
    expect(setup.view().stages).toHaveLength(4);
  });

  test("fresh setup uses the detected private address without showing connection controls", () => {
    const setup = session();

    expect(highlighted(setup)).toBe("username");
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
    expect(setup.view().activeStage).toBe(1);
    expect(setup.view().completed).toEqual([true, true, false, false]);

    expect(highlighted(setup)).toBe("provider:openai-codex");
    enter(setup);
    expect(setup.view().activeStage).toBe(2);
    expect(highlighted(setup)).toBe("apply");
    expect(setup.view().rows).toContainEqual({
      kind: "field",
      label: "Address",
      value: "http://100.100.10.5:8787",
    });
    expect(
      setup.view().rows.some((row) => row.kind === "field" && row.label === "Connection")
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
    expect(
      setup.rows().filter((row) => row.kind === "note" && row.tone === "warning")
    ).toHaveLength(1);

    expect(enter(setup)).toEqual({ type: "continue" });
    expect(setup.view().activeStage).toBe(0);
    expect(highlighted(setup)).toBe("password");
    expect(setup.view().notice).toEqual({
      text: "Set your password in Account.",
      tone: "warning",
    });
    expect(() => setup.configuration()).toThrow("Set your password");
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
    const setup = session({ detectedPrivateHost: null });
    expect(highlighted(setup)).toBe("host");

    type(setup, "192.168.1.20");
    expect(setup.view().mode).toBe("edit");
    expect(setup.view().rows.find((row) => row.kind === "text" && row.id === "host")).toMatchObject(
      { editing: { buffer: "192.168.1.20" } }
    );

    enter(setup);
    expect(setup.state.host).toBe("192.168.1.20");
    expect(setup.view().activeStage).toBe(1);
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
      "host",
      "httpAck",
    ]);
    edit(setup, "203.0.113.9");
    expect(setup.problems().map((problem) => problem.rowId)).toEqual(["httpAck", "password"]);

    expect(highlighted(setup)).toBe("httpAck");
    press(setup, "space");
    expect(setup.state.httpAcknowledged).toBe(true);
    expect(setup.problems().map((problem) => problem.rowId)).toEqual(["password"]);
  });

  test("private mode prefills the detected address and keeps viewers on the LAN", () => {
    const setup = session({ detectedPrivateHost: "100.100.10.5", ownerConfigured: true });
    expect(setup.view().title).toBe("1. Account");
    expect(setup.view().stages.map((stage) => stage.label)).toEqual([
      "Account",
      "Inference",
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

  test("switching providers resets the model, authentication defaults, and any typed key", () => {
    const setup = session({ authenticated: true, ownerConfigured: true });
    press(setup, "right");
    expect(setup.state.authenticate).toBe(false);
    expect(
      setup.rows().find((row) => row.kind === "toggle" && row.id === "authenticate")
    ).toBeUndefined();

    type(setup, "2");
    expect(setup.state).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      authenticate: true,
      authType: "oauth",
    });
    expect(highlighted(setup)).toBe("authType");
    expect(rowIds(setup)).toEqual([
      "provider:openai-codex",
      "provider:anthropic",
      "provider:openai",
      "provider:custom",
      "inference:skip",
      "authType",
    ]);

    enter(setup);
    expect(setup.state.authType).toBe("api_key");
    press(setup, "down");
    expect(highlighted(setup)).toBe("apiKey");
    edit(setup, "anthropic-test-secret");
    expect(setup.configuration()).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      authenticate: true,
      authType: "api_key",
      apiKey: "anthropic-test-secret",
    });

    press(setup, "left");
    press(setup, "home");
    type(setup, "3");
    expect(setup.state).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      authenticate: true,
      authType: "api_key",
      apiKey: null,
    });
    expect(setup.problems().map((problem) => problem.message)).toEqual([
      "Enter an API key in Inference.",
    ]);

    press(setup, "home");
    type(setup, "1");
    expect(setup.state).toMatchObject({ provider: "openai-codex", model: "gpt-5.5" });
    expect(setup.state.authenticate).toBe(false);
  });

  test("quick setup shows the chosen model without exposing tuning controls", () => {
    const setup = session();
    press(setup, "right");

    expect(setup.rows()).toContainEqual({ kind: "field", label: "Model", value: "gpt-5.5" });
    expect(rowIds(setup)).not.toContain("model");
    expect(rowIds(setup)).not.toContain("thinking");
    expect(rowIds(setup)).not.toContain("workerConcurrency");
    expect(rowIds(setup)).not.toContain("authenticate");
  });

  test("inference can be skipped without requiring provider details or sign-in", () => {
    const setup = session({ ownerConfigured: true });
    press(setup, "right");

    type(setup, "5");

    expect(setup.state.skipInference).toBe(true);
    expect(setup.view().title).toBe("3. Review");
    expect(setup.problems()).toEqual([]);
    expect(setup.rows()).toContainEqual({
      kind: "field",
      label: "Inference",
      value: "Skip for now",
    });
    expect(setup.configuration()).toMatchObject({
      skipInference: true,
      authenticate: false,
      provider: "openai-codex",
      model: "gpt-5.5",
    });
  });

  test("custom providers collect every field, cycle the API, and register on apply", () => {
    const setup = session({ ownerConfigured: true });
    press(setup, "right");
    type(setup, "4");
    expect(setup.state.provider).toBe("custom");
    expect(highlighted(setup)).toBe("custom.id");
    expect(rowIds(setup)).toEqual([
      "provider:openai-codex",
      "provider:anthropic",
      "provider:openai",
      "provider:custom",
      "inference:skip",
      "custom.id",
      "custom.name",
      "custom.baseUrl",
      "custom.api",
      "custom.model",
      "custom.reasoning",
      "apiKey",
    ]);

    edit(setup, "BAD ID");
    expect(setup.view().mode).toBe("edit");
    press(setup, "u", { ctrl: true });
    type(setup, "acme");
    enter(setup);
    expect(highlighted(setup)).toBe("custom.name");
    edit(setup, "Acme AI");
    expect(highlighted(setup)).toBe("custom.baseUrl");
    edit(setup, "ftp://api.example.com");
    expect(setup.view().mode).toBe("edit");
    press(setup, "u", { ctrl: true });
    type(setup, "https://api.example.com/v1/");
    enter(setup);
    expect(highlighted(setup)).toBe("custom.api");
    enter(setup);
    enter(setup);
    enter(setup);
    expect(setup.state.custom.api).toBe("google-generative-ai");
    press(setup, "down");
    edit(setup, "gemini-2.5-pro");
    expect(highlighted(setup)).toBe("custom.reasoning");
    enter(setup);
    press(setup, "down");
    edit(setup, "generic-provider-password");

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
    press(setup, "right");
    press(setup, "right");
    expect(rowIds(setup).slice(0, 2)).toEqual(["apiPort", "timeZone"]);
    expect(highlighted(setup)).toBe("provider:openai-codex");
    type(setup, "2");
    expect(highlighted(setup)).toBe("model");
    press(setup, "home");
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
    edit(setup, "Europe/London");
    expect(rowIds(setup)).toContain("thinking");
    expect(rowIds(setup)).toContain("workerConcurrency");
    press(setup, "end");
    expect(highlighted(setup)).toBe("authType");
    press(setup, "up");
    press(setup, "up");
    expect(highlighted(setup)).toBe("workerConcurrency");
    edit(setup, "4");
    expect(highlighted(setup)).toBe("authenticate");
    press(setup, "up");
    press(setup, "up");
    expect(highlighted(setup)).toBe("thinking");
    enter(setup);
    expect(setup.state.thinking).toBe("xhigh");

    press(setup, "left");
    press(setup, "left");
    type(setup, "2");
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
    expect(setup.view().title).toBe("1. Account");
    expect(setup.view().cursorRow).toBe(-1);
    expect(setup.rows().map((row) => row.kind)).toEqual(["note", "note"]);
    press(setup, "right");
    expect(highlighted(setup)).toBe("provider:acme");
    expect(
      setup.rows().find((row) => row.kind === "option" && row.id === "provider:acme")
    ).toMatchObject({ label: "Keep acme", selected: true, recommended: true });
    expect(setup.view().completed).toEqual([true, true, false, false]);
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

  test("launch notes surface port fallbacks and the cancel action ends without changes", () => {
    const setup = session({
      current: environment({ OPENTEAM_API_PORT: "8788" }),
      notes: [{ text: "Port 8787 is already in use; using 8788.", tone: "info" }],
    });
    press(setup, "right");
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
