import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyboardShortcutStore } from "../src/main/keyboard-shortcuts";
import { checkShortcut, resolveShortcutBindings } from "../src/renderer/lib/keyboard-shortcut-rules";
import {
  canonicalShortcut,
  defaultShortcutBindings,
  FN_KEY,
  matchesShortcut,
  shortcutKeycaps,
  shortcutText,
} from "../src/renderer/lib/keyboard-shortcuts";

const key = (code: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code, ...modifiers });

describe("keyboard shortcuts", () => {
  test("defaults, keycaps and text", () => {
    const defaults = defaultShortcutBindings();
    expect(shortcutKeycaps(defaults.search, true)).toEqual(["⌘", "K"]);
    expect(shortcutText(defaults.nextBot, true)).toBe("⌘↓");
    expect(shortcutText(defaults.previousBot, false)).toBe("Ctrl+↑");
    expect(shortcutText(defaults.settings, true)).toBe("⌘,");
    expect(shortcutText(FN_KEY, true)).toBe("🌐 Fn");
  });

  test("one spelling per shortcut", () => {
    expect(canonicalShortcut("Shift+CmdOrCtrl+k", true)).toBe("Command+Shift+K");
    expect(canonicalShortcut("CommandOrControl+Down", false)).toBe("Control+Down");
    expect(canonicalShortcut("Shift+K", true)).toBeNull();
    expect(canonicalShortcut("Command+Bogus", true)).toBeNull();
  });

  test("matches physical keys with exactly the binding's modifiers", () => {
    expect(matchesShortcut(key("KeyK", { metaKey: true }), "CommandOrControl+K", true)).toBe(true);
    expect(matchesShortcut(key("KeyK", { metaKey: true, shiftKey: true }), "CommandOrControl+K", true)).toBe(false);
    expect(matchesShortcut(key("KeyK", { ctrlKey: true }), "CommandOrControl+K", true)).toBe(false);
    expect(matchesShortcut(key("KeyK", { ctrlKey: true }), "CommandOrControl+K", false)).toBe(true);
    expect(matchesShortcut(key("ArrowDown", { metaKey: true }), "CommandOrControl+Down", true)).toBe(true);
    expect(matchesShortcut(key("Comma", { metaKey: true }), "CommandOrControl+,", true)).toBe(true);
    expect(matchesShortcut(key("KeyD", { metaKey: true }), FN_KEY, true)).toBe(false);
  });

  test("refuses clashes, system shortcuts and Fn outside dictation", () => {
    const current = defaultShortcutBindings();
    expect(checkShortcut("search", "Command+B", current, true)).toBe("Show or hide the sidebar already uses that shortcut.");
    expect(checkShortcut("search", "Command+C", current, true)).toBe("Your system uses that shortcut. Pick another.");
    expect(checkShortcut("search", FN_KEY, current, true)).toBe("Only dictation can use the Fn key on its own.");
    expect(checkShortcut("dictate", FN_KEY, current, false)).toBe("The Fn key on its own needs a Mac.");
    expect(checkShortcut("dictate", FN_KEY, current, true)).toBeNull();
    expect(checkShortcut("search", "Command+Shift+2", current, true, "CommandOrControl+Shift+2")).toBe("ScreenBot already uses that shortcut.");
    expect(checkShortcut("search", "Command+Shift+F", current, true)).toBeNull();
  });

  test("saved bindings survive a swap; unusable ones fall back", () => {
    expect(resolveShortcutBindings({ search: "Command+B", toggleSidebar: "Command+K" }, true)).toMatchObject({ search: "Command+B", toggleSidebar: "Command+K" });
    expect(resolveShortcutBindings({ search: "Command+B" }, true).search).toBe("CommandOrControl+K");
    expect(resolveShortcutBindings({ search: "Command+C", dictate: FN_KEY }, true)).toMatchObject({ search: "CommandOrControl+K", dictate: FN_KEY });
    expect(resolveShortcutBindings("garbage", true)).toEqual(defaultShortcutBindings());
  });

  test("the store saves only changes, rejects clashes and resets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcuts-"));
    const path = join(directory, "keyboard-shortcuts.json");
    const changes: string[] = [];
    try {
      const store = new KeyboardShortcutStore({ path, platform: "darwin", screenBotAccelerator: () => null, onChange: (view) => changes.push(view.bindings.dictate) });
      await store.start();
      await store.set("dictate", FN_KEY);
      expect(JSON.parse(await readFile(path, "utf8")).bindings).toEqual({ dictate: FN_KEY });
      await expect(store.set("nextBot", "Command+K")).rejects.toThrow("Search already uses that shortcut.");
      await store.set("dictate", null);
      expect(JSON.parse(await readFile(path, "utf8")).bindings).toEqual({});
      expect(changes).toEqual(["CommandOrControl+D", FN_KEY, "CommandOrControl+D"]);
      const reloaded = new KeyboardShortcutStore({ path, platform: "darwin", screenBotAccelerator: () => null, onChange: () => undefined });
      await reloaded.start();
      expect(reloaded.get("dictate")).toBe("CommandOrControl+D");
      expect(store.conflictWith("CmdOrCtrl+D")).toBe("Dictation already uses that shortcut.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("overlapping conflicting saves reject once and reload without changing either binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcuts-race-"));
    try {
      const path = join(directory, "settings.json");
      const create = () => new KeyboardShortcutStore({ path, platform: "darwin", screenBotAccelerator: () => null, onChange() {} });
      const store = create(); await store.start();
      const results = await Promise.allSettled([store.set("search", "Command+Shift+F"), store.set("toggleSidebar", "Command+Shift+F")]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect((results[1] as PromiseRejectedResult).reason.message).toContain("Search already uses");
      expect(JSON.parse(await readFile(path, "utf8")).bindings).toEqual({ search: "Command+Shift+F" });
      const reloaded = create(); await reloaded.start();
      expect(reloaded.view()).toEqual(store.view());
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("queued resets validate after earlier saves free or claim the default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcuts-reset-race-"));
    try {
      const store = new KeyboardShortcutStore({ path: join(directory, "settings.json"), platform: "darwin", screenBotAccelerator: () => null, onChange() {} });
      await store.start();
      await store.set("search", "Command+Shift+F");
      await store.set("toggleSidebar", "Command+K");
      // The default K is in use when reset is submitted; the earlier queued save frees it.
      await Promise.all([store.set("toggleSidebar", "Command+Shift+B"), store.set("search", null)]);
      expect(store.get("search")).toBe("CommandOrControl+K");
      await store.set("search", "Command+Shift+F");
      const claimed = await Promise.allSettled([store.set("toggleSidebar", "Command+K"), store.set("search", null)]);
      expect(claimed.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(store.get("search")).toBe("Command+Shift+F");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("queued validation uses current ScreenBot reservation and retains sequential system checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcuts-reserved-"));
    let reserved: string | null = null;
    try {
      const store = new KeyboardShortcutStore({ path: join(directory, "settings.json"), platform: "darwin", screenBotAccelerator: () => reserved, onChange() {} });
      await store.start();
      const pending = store.set("search", "Command+Shift+F");
      reserved = "Command+Shift+F";
      await expect(pending).rejects.toThrow("ScreenBot already uses");
      await expect(store.set("search", "Command+C")).rejects.toThrow("Your system uses");
      await expect(store.set("search", "bad-key")).rejects.toThrow("Include");
      await expect(store.set("missing", null)).rejects.toThrow("can’t be changed");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("failed persistence rolls back memory and notifications and does not poison the queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shortcuts-write-failure-"));
    try {
      const path = join(directory, "settings.json");
      const changes: unknown[] = [];
      const store = new KeyboardShortcutStore({ path, platform: "darwin", screenBotAccelerator: () => null, onChange: (view) => changes.push(view) });
      await store.start(); const before = store.view();
      await mkdir(path); // Owned path makes the atomic rename fail deterministically.
      const failures = await Promise.allSettled([store.set("search", "Command+Shift+F"), store.set("toggleSidebar", "Command+Shift+F")]);
      expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(store.view()).toEqual(before); expect(changes).toHaveLength(1);
      await rm(path, { recursive: true });
      await store.set("toggleSidebar", "Command+Shift+F");
      expect(store.get("search")).toBe(before.bindings.search);
      expect(JSON.parse(await readFile(path, "utf8")).bindings).toEqual({ toggleSidebar: "Command+Shift+F" });
      expect(changes).toHaveLength(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
