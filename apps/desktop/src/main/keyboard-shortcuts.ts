import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  canonicalShortcut,
  defaultShortcutBindings,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  type ShortcutBindings,
} from "../renderer/lib/keyboard-shortcuts";
import {
  checkShortcut,
  resolveShortcutBindings,
} from "../renderer/lib/keyboard-shortcut-rules";

export interface KeyboardShortcutsView {
  bindings: ShortcutBindings;
  defaults: ShortcutBindings;
}

/**
 * The app's rebindable shortcuts, saved in userData. Main owns them because the menu (Settings)
 * and the Fn key (read by the native helper) are main's, and every window must agree.
 */
export class KeyboardShortcutStore {
  private bindings: ShortcutBindings;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: {
    path: string;
    platform: NodeJS.Platform;
    /** The screenbot trigger when it's an ordinary shortcut: nothing else may use it. */
    screenBotAccelerator: () => string | null;
    onChange: (view: KeyboardShortcutsView) => void;
  }) {
    this.bindings = resolveShortcutBindings(null, this.mac);
  }

  private get mac() {
    return this.options.platform === "darwin";
  }

  async start() {
    try {
      const saved = JSON.parse(await readFile(this.options.path, "utf8")) as { bindings?: unknown };
      this.bindings = resolveShortcutBindings(saved.bindings, this.mac);
    } catch {
      this.bindings = resolveShortcutBindings(null, this.mac);
    }
    this.options.onChange(this.view());
  }

  view(): KeyboardShortcutsView {
    return { bindings: { ...this.bindings }, defaults: defaultShortcutBindings() };
  }

  get(action: ShortcutAction) {
    return this.bindings[action];
  }

  /** Why a ScreenBot accelerator can't be used, because one of these shortcuts has it. */
  conflictWith(accelerator: string): string | null {
    const target = canonicalShortcut(accelerator, this.mac);
    const action = SHORTCUT_ACTIONS.find((candidate) => canonicalShortcut(this.bindings[candidate], this.mac) === target);
    return action ? `${action === "dictate" ? "Dictation" : "Another shortcut"} already uses that shortcut.` : null;
  }

  /** Saves one binding; null resets it to its default. Rejects with the reason it can't be used. */
  set(action: unknown, value: unknown): Promise<KeyboardShortcutsView> {
    if (!SHORTCUT_ACTIONS.includes(action as ShortcutAction)) return Promise.reject(new Error("That shortcut can’t be changed."));
    const name = action as ShortcutAction;
    const binding = value === null ? defaultShortcutBindings()[name] : typeof value === "string" ? canonicalShortcut(value, this.mac) : null;
    if (!binding) return Promise.reject(new Error("Include ⌘, ⌃ or ⌥ (or Ctrl or Alt) with a key."));
    const run = this.saving.then(async () => {
      // Earlier queued saves may have claimed this binding (or freed it for a reset).
      const error = checkShortcut(name, binding, this.bindings, this.mac, this.options.screenBotAccelerator());
      if (error) throw new Error(error);
      const next = { ...this.bindings, [name]: binding };
      const defaults = defaultShortcutBindings();
      // Only what differs from the defaults, so new defaults reach anyone who never changed them.
      const overrides = Object.fromEntries(SHORTCUT_ACTIONS.filter((key) => canonicalShortcut(next[key], this.mac) !== canonicalShortcut(defaults[key], this.mac)).map((key) => [key, next[key]]));
      await mkdir(dirname(this.options.path), { recursive: true });
      const temporary = `${this.options.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, bindings: overrides }), { mode: 0o600 });
      await rename(temporary, this.options.path);
      this.bindings = next;
      this.options.onChange(this.view());
      return this.view();
    });
    this.saving = run.catch(() => undefined);
    return run;
  }
}
