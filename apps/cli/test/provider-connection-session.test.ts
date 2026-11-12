import { describe, expect, test } from "bun:test";
import {
  authView,
  choose,
  connectionFixture,
  connectionScreen,
  settle,
} from "./fixtures/provider-connection";

describe("provider connection screen", () => {
  test.each(["ctrl-c", "button"])("%s cancels the remote browser session and returns to the picker", async (key) => {
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
  test("EOF cleanup cancels a pending browser session", async () => {
    const f = connectionFixture();
    choose(f.session, "browser");
    await settle(() => f.session.actions().some((a) => a.id === "open"));
    await f.session.dispose();
    expect(f.calls.cancel).toEqual(["session-1"]);
  });
});
