import { describe, expect, test } from "bun:test";
import {
  ignoresSubmit,
  nextOptionIndex,
  SETTLE_MS,
  setupKeyAction,
} from "../src/renderer/components/openteam/setup/setup-guards";
import { serverAddressProblem } from "../src/renderer/lib/server-address";

// A stand-in for a DOM element: `matches` lists the selectors its closest() would find.
const target = (matches: string[] = [], isConnected = true) => ({
  isConnected,
  closest: (selectors: string) =>
    selectors.split(",").some((selector) => matches.includes(selector.trim())) ? {} : null,
});

describe("setup keys", () => {
  test("Enter on the page submits and Esc goes back", () => {
    expect(setupKeyAction("Enter", target())).toBe("submit");
    expect(setupKeyAction("Escape", target())).toBe("back");
    expect(setupKeyAction("Enter", null)).toBe("submit");
  });

  test("fields and buttons handle their own Enter", () => {
    expect(setupKeyAction("Enter", target(["input"]))).toBeNull();
    expect(setupKeyAction("Enter", target(["button"]))).toBeNull();
    // Esc still steps back from a field.
    expect(setupKeyAction("Escape", target(["input"]))).toBe("back");
  });

  test("a key a menu used is not used again", () => {
    // The menu is still open, or it closed on this key and its option is gone.
    expect(setupKeyAction("Enter", target(), { menuOpen: true })).toBeNull();
    expect(setupKeyAction("Escape", target(), { menuOpen: true })).toBeNull();
    expect(setupKeyAction("Enter", target([], false))).toBeNull();
    expect(setupKeyAction("Escape", target([], false))).toBeNull();
    expect(setupKeyAction("Enter", target(["[role='option']"]))).toBeNull();
  });

  test("nothing is submitted while the primary button is disabled or Enter repeats", () => {
    expect(setupKeyAction("Enter", target(), { submitDisabled: true })).toBeNull();
    expect(setupKeyAction("Enter", target(), { repeat: true })).toBeNull();
    expect(setupKeyAction("Escape", target(), { submitDisabled: true })).toBe("back");
  });

  test("other keys do nothing", () => {
    expect(setupKeyAction("a", target())).toBeNull();
    expect(setupKeyAction("Tab", target())).toBeNull();
  });
});

describe("settling after a screen appears", () => {
  test("drops a submit that follows a new screen too closely", () => {
    expect(ignoresSubmit(1_000, 1_000 + SETTLE_MS - 1, false)).toBe(true);
    expect(ignoresSubmit(1_000, 1_000 + SETTLE_MS, false)).toBe(false);
  });

  test("lets an answer that was typed, pasted or pressed through", () => {
    expect(ignoresSubmit(1_000, 1_050, true)).toBe(false);
  });
});

describe("server addresses", () => {
  test("accepts what setup prints, with or without a scheme", () => {
    for (const address of [
      "192.168.1.20:8787",
      "localhost:8787",
      "openteam.example.com",
      "https://openteam.example.com",
      "http://100.64.0.1:8787/",
      "[::1]:8787",
    ]) {
      expect(serverAddressProblem(address)).toBeNull();
    }
  });

  test("explains addresses that can't work without asking for http://", () => {
    expect(serverAddressProblem("   ")).toContain("192.168.1.20:8787");
    expect(serverAddressProblem("my server")).toContain("no spaces");
    expect(serverAddressProblem("http://")).toContain("doesn't look like a server address");
    expect(serverAddressProblem("ftp://example.com")).toContain(
      "doesn't look like a server address"
    );
    expect(serverAddressProblem("admin:pw@192.168.1.20:8787")).toContain("username and password");
    expect(serverAddressProblem("192.168.1.20:8787?token=1")).toContain("after ? or #");
    for (const address of ["my server", "http://", "ftp://example.com"]) {
      expect(serverAddressProblem(address)).not.toContain("http://");
    }
  });
});

test("the arrow keys move between option rows, wrapping around", () => {
  expect(nextOptionIndex("ArrowDown", -1, 3)).toBe(0);
  expect(nextOptionIndex("ArrowUp", -1, 3)).toBe(2);
  expect(nextOptionIndex("ArrowDown", 2, 3)).toBe(0);
  expect(nextOptionIndex("ArrowUp", 0, 3)).toBe(2);
  expect(nextOptionIndex("ArrowDown", 0, 0)).toBeNull();
  expect(nextOptionIndex("Enter", 0, 3)).toBeNull();
});
