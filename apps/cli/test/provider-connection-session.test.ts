import { describe, expect, test } from "bun:test";
import { terminalTextWidth } from "../src/terminal";
import {
  authView,
  choose,
  connectionFixture,
  connectionScreen,
  settle,
} from "./fixtures/provider-connection";

describe("provider connection screen", () => {
  test("offers local import, browser sign-in and Back before starting OAuth", async () => {
    const f = connectionFixture();
    expect(f.session.actions().map((a) => a.label)).toEqual([
      "Use Claude Code login",
      "Browser sign-in",
      "Back to providers",
    ]);
    expect(f.calls.start).toBe(0);
    let result: unknown;
    f.session.subscribe((value) => {
      if (value) result = value;
    });
    f.session.handle("", { name: "escape" });
    await settle(() => !!result);
    expect(result).toEqual({ type: "complete", value: "cancelled" });
    expect(f.calls.start).toBe(0);
    expect(f.calls.imports).toHaveLength(0);
    await f.session.dispose();
  });
  test.each([
    "escape",
    "ctrl-c",
    "button",
  ])("%s cancels the remote browser session and returns to the picker", async (key) => {
    const f = connectionFixture();
    let result: unknown;
    f.session.subscribe((value) => {
      if (value) result = value;
    });
    choose(f.session, "browser");
    await settle(() => f.session.actions().some((a) => a.id === "open"));
    expect(connectionScreen(f.session)).not.toContain("synthetic-state");
    expect(connectionScreen(f.session)).not.toContain("here::");
    expect(f.calls.links).toHaveLength(0);
    if (key === "button") choose(f.session, "cancel");
    else f.session.handle("", key === "ctrl-c" ? { ctrl: true, name: "c" } : { name: "escape" });
    await settle(() => !!result);
    expect(result).toEqual({ type: "complete", value: "cancelled" });
    expect(f.calls.cancel).toEqual(["session-1"]);
    await f.session.dispose();
    expect(f.calls.cancel).toHaveLength(1);
  });
  test("Esc during a delayed start cancels the session as soon as its id arrives", async () => {
    const f = connectionFixture();
    let start!: (view: ReturnType<typeof authView>) => void;
    f.api.start = () =>
      new Promise((resolve) => {
        start = resolve;
      });
    let result: unknown;
    f.session.subscribe((value) => {
      if (value) result = value;
    });
    choose(f.session, "browser");
    f.session.handle("", { name: "escape" });
    expect(connectionScreen(f.session)).toContain("Cancelling");
    start(authView());
    await settle(() => !!result);
    expect(f.calls.cancel).toEqual(["session-1"]);
    await f.session.dispose();
  });
  test("paste can be cancelled separately and never echoes a code or redirect URL", async () => {
    const f = connectionFixture();
    choose(f.session, "browser");
    await settle(() => f.session.actions().some((a) => a.id === "paste"));
    choose(f.session, "paste");
    f.session.handle("http://localhost/callback?code=synthetic-sensitive-code", {});
    expect(connectionScreen(f.session)).toContain("••••");
    expect(connectionScreen(f.session)).not.toContain("synthetic-sensitive-code");
    f.session.handle("", { name: "escape" });
    expect(f.session.actions().some((a) => a.id === "paste")).toBe(true);
    expect(f.calls.responses).toHaveLength(0);
    choose(f.session, "paste");
    f.session.handle("new-code", {});
    f.session.handle("", { name: "return" });
    await settle(() => connectionScreen(f.session).includes("Connected."));
    expect(f.calls.responses).toEqual(["new-code"]);
    await f.session.dispose();
  });
  test("API keys are hidden and the successful connection continues to models", async () => {
    const f = connectionFixture("api_key");
    f.session.handle("synthetic-api-key", {});
    expect(connectionScreen(f.session)).not.toContain("synthetic-api-key");
    f.session.handle("", { name: "return" });
    await settle(() => connectionScreen(f.session).includes("Connected."));
    expect(f.calls.responses).toEqual(["synthetic-api-key"]);
    expect(choose(f.session, "done")).toEqual({ type: "complete", value: "connected" });
    await f.session.dispose();
  });
  test("missing or expired local login leaves browser sign-in and Back available", async () => {
    const f = connectionFixture();
    f.api.importLogin = async () => {
      throw new Error("No reusable Claude Code login found. Choose Browser sign-in.");
    };
    choose(f.session, "import");
    await settle(() => connectionScreen(f.session).includes("No reusable"));
    expect(f.session.actions().some((a) => a.id === "browser")).toBe(true);
    expect(f.session.actions().some((a) => a.id === "cancel")).toBe(true);
    expect(f.calls.start).toBe(0);
    await f.session.dispose();
  });
  test("importing a saved login connects without starting browser OAuth", async () => {
    const f = connectionFixture();
    choose(f.session, "import");
    await settle(() => connectionScreen(f.session).includes("Connected."));
    expect(f.calls.imports).toEqual(["anthropic"]);
    expect(f.calls.start).toBe(0);
    await f.session.dispose();
  });
  test("polling updates browser completion without a keypress and then stops", async () => {
    const f = connectionFixture("oauth", 5);
    let updates = 0;
    f.session.subscribe(() => {
      updates++;
    });
    choose(f.session, "browser");
    await settle(() => f.calls.read > 0);
    const unchanged = updates;
    await Bun.sleep(20);
    expect(updates).toBe(unchanged);
    f.set({ status: "connected", prompt: null });
    await settle(() => connectionScreen(f.session).includes("Connected."));
    expect(updates).toBeGreaterThan(1);
    const count = f.calls.read;
    await Bun.sleep(20);
    expect(f.calls.read).toBe(count);
    await f.session.dispose();
  });
  test("poll failure leaves cancellation usable and a failed cancellation can be retried", async () => {
    const f = connectionFixture("oauth", 5);
    f.api.read = async () => {
      throw new Error("Offline");
    };
    let attempts = 0;
    f.api.cancel = async () => {
      if (++attempts === 1) throw new Error("Offline");
    };
    let result: unknown;
    f.session.subscribe((value) => {
      if (value) result = value;
    });
    choose(f.session, "browser");
    await settle(() => connectionScreen(f.session).includes("Could not check"));
    f.session.handle("", { name: "escape" });
    await settle(() => connectionScreen(f.session).includes("retry cancellation"));
    expect(result).toBeUndefined();
    f.session.handle("", { name: "escape" });
    await settle(() => !!result);
    expect(attempts).toBe(2);
    await f.session.dispose();
  });
  test("supports device-code choices, browser failures and compact widths", async () => {
    const f = connectionFixture();
    f.set({
      prompt: {
        id: "method",
        type: "select",
        message: "Select",
        options: [
          { id: "device", label: "Device code", description: "Use a browser on another machine." },
          { id: "browser", label: "Browser" },
        ],
      },
    });
    f.api.respond = async () =>
      authView({
        prompt: null,
        deviceCode: { userCode: "ABCD-1234", verificationUri: "https://auth.openai.com/device" },
      });
    choose(f.session, "browser");
    await settle(() => f.session.actions().some((a) => a.id === "option:device"));
    choose(f.session, "option:device");
    await settle(() => connectionScreen(f.session).includes("ABCD-1234"));
    for (const width of [24, 40, 60, 90, 110])
      expect(
        connectionScreen(f.session, width)
          .split("\n")
          .every((line) => terminalTextWidth(line) <= width)
      ).toBe(true);
    await f.session.dispose();
  });
  test("API key submission waits for a delayed provider prompt", async () => {
    const f = connectionFixture("api_key");
    f.api.start = async () => authView({ authType: "api_key", status: "running", prompt: null });
    f.session.handle("test-key", {});
    f.session.handle("", { name: "return" });
    await settle(() => connectionScreen(f.session).includes("Connected."));
    expect(f.calls.responses).toEqual(["test-key"]);
    await f.session.dispose();
  });
  test("EOF cleanup cancels a pending browser session", async () => {
    const f = connectionFixture();
    choose(f.session, "browser");
    await settle(() => f.session.actions().some((a) => a.id === "open"));
    await f.session.dispose();
    expect(f.calls.cancel).toEqual(["session-1"]);
  });
});
