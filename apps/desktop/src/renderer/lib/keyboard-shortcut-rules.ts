// The rules for rebinding shortcuts: their names, the ones the system keeps, and the checks a
// new binding must pass. Only Settings and the main process need these, so they stay out of
// the windows' startup code (keyboard-shortcuts.ts has what a key handler needs).
import {
  canonicalShortcut,
  defaultShortcutBindings,
  FN_KEY,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  type ShortcutBindings,
} from "./keyboard-shortcuts";

export const SHORTCUT_LABELS: Record<ShortcutAction, { title: string; description: string }> = {
  search: { title: "Search", description: "Find a Bot, message or setting." },
  toggleSidebar: { title: "Show or hide the sidebar", description: "Switch between the full and compact sidebar." },
  settings: { title: "Settings", description: "Open these settings." },
  dictate: { title: "Dictate", description: "Hold to dictate. Press twice quickly to keep dictating until you press it again. Works in the chat and in ScreenBot." },
  previousBot: { title: "Previous Bot", description: "Go to the conversation above in the sidebar, or the previous Bot in ScreenBot." },
  nextBot: { title: "Next Bot", description: "Go to the conversation below in the sidebar, or the next Bot in ScreenBot." },
};


// Shortcuts macOS and Windows themselves use while you type or switch apps. A window's own
// shortcut can't take these without breaking copy, paste, quitting or switching.
const RESERVED_MAC = [
  ..."ACVXZQHMW".split("").map((key) => `Command+${key}`),
  "Command+Tab", "Command+Space", "Command+`", "Command+Shift+Z", "Command+Shift+3",
  "Command+Shift+4", "Command+Shift+5", "Command+Alt+Escape", "Control+Space",
];
const RESERVED_OTHER = [
  ..."ACVXZYW".split("").map((key) => `Control+${key}`),
  "Alt+Tab", "Alt+F4", "Control+Escape", "Super+L", "Super+D", "Super+Tab",
];

export interface ShortcutCheck {
  /** null when the binding can be used. */
  error: string | null;
}

/**
 * Whether `binding` can be saved for `action`: a real shortcut (Fn only for dictation, on a
 * Mac), not one the system needs, and not already used by another action or by the screenbot
 * trigger.
 */
export const checkShortcut = (
  action: ShortcutAction,
  binding: string,
  current: ShortcutBindings,
  mac: boolean,
  screenBotAccelerator: string | null = null
): string | null => {
  if (binding === FN_KEY) {
    if (action !== "dictate") return "Only dictation can use the Fn key on its own.";
    if (!mac) return "The Fn key on its own needs a Mac.";
  } else {
    const canonical = canonicalShortcut(binding, mac);
    if (!canonical) return "Include ⌘, ⌃ or ⌥ (or Ctrl or Alt) with a key.";
    const reserved = (mac ? RESERVED_MAC : RESERVED_OTHER).map((value) => canonicalShortcut(value, mac));
    if (reserved.includes(canonical)) return "Your system uses that shortcut. Pick another.";
    if (screenBotAccelerator && canonicalShortcut(screenBotAccelerator, mac) === canonical) return "ScreenBot already uses that shortcut.";
  }
  const target = canonicalShortcut(binding, mac);
  for (const other of SHORTCUT_ACTIONS) {
    if (other !== action && canonicalShortcut(current[other], mac) === target) {
      return `${SHORTCUT_LABELS[other].title} already uses that shortcut.`;
    }
  }
  return null;
};

/** Saved overrides on top of the defaults, checked as a set (so a swap survives); anything
 * unusable or clashing goes back to its default. */
export const resolveShortcutBindings = (saved: unknown, mac: boolean): ShortcutBindings => {
  const defaults = defaultShortcutBindings();
  const bindings = { ...defaults };
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return bindings;
  for (const action of SHORTCUT_ACTIONS) {
    const value = (saved as Record<string, unknown>)[action];
    const canonical = typeof value === "string" ? canonicalShortcut(value, mac) : null;
    if (canonical) bindings[action] = canonical;
  }
  for (let pass = 0; pass < SHORTCUT_ACTIONS.length; pass += 1) {
    const bad = SHORTCUT_ACTIONS.find((action) => bindings[action] !== defaults[action] && checkShortcut(action, bindings[action], bindings, mac));
    if (!bad) break;
    bindings[bad] = defaults[bad];
  }
  return bindings;
};
