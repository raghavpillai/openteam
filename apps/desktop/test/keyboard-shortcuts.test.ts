import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    expect(checkShortcut("search", "Command+Shift+2", current, true, "CommandOrControl+Shift+2")).toBe("Appshots already use that shortcut.");
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
      const store = new KeyboardShortcutStore({ path, platform: "darwin", appshotAccelerator: () => null, onChange: (view) => changes.push(view.bindings.dictate) });
      await store.start();
      await store.set("dictate", FN_KEY);
      expect(JSON.parse(await readFile(path, "utf8")).bindings).toEqual({ dictate: FN_KEY });
      await expect(store.set("nextBot", "Command+K")).rejects.toThrow("Search already uses that shortcut.");
      await store.set("dictate", null);
      expect(JSON.parse(await readFile(path, "utf8")).bindings).toEqual({});
      expect(changes).toEqual(["CommandOrControl+D", FN_KEY, "CommandOrControl+D"]);
      const reloaded = new KeyboardShortcutStore({ path, platform: "darwin", appshotAccelerator: () => null, onChange: () => undefined });
      await reloaded.start();
      expect(reloaded.get("dictate")).toBe("CommandOrControl+D");
      expect(store.conflictWith("CmdOrCtrl+D")).toBe("Dictation already uses that shortcut.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
