// The app's keyboard shortcuts: what each action is bound to, and how a binding is checked,
// matched against a key press and drawn as keycaps. Pure: the main process (which stores the
// bindings and owns the menu) and every window share it.

export const SHORTCUT_ACTIONS = ["search", "toggleSidebar", "settings", "dictate", "previousBot", "nextBot"] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
export type ShortcutBindings = Record<ShortcutAction, string>;

/** The Fn (🌐) key on its own, pressed and released. Only dictation can use it. */
export const FN_KEY = "Fn";

export const defaultShortcutBindings = (): ShortcutBindings => ({
  search: "CommandOrControl+K",
  toggleSidebar: "CommandOrControl+B",
  settings: "CommandOrControl+,",
  dictate: "CommandOrControl+D",
  previousBot: "CommandOrControl+Up",
  nextBot: "CommandOrControl+Down",
});

const MODIFIER = /^(?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)$/;
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|[`\-=[\];',./\\])$/;
const MODIFIER_ORDER = ["Command", "Control", "Alt", "Shift", "Super"];

export interface ParsedShortcut {
  command: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  /** Super on Windows and Linux (the Windows key). */
  super: boolean;
  key: string;
}

const canonicalModifier = (part: string, mac: boolean) => {
  if (part === "CommandOrControl" || part === "CmdOrCtrl") return mac ? "Command" : "Control";
  if (part === "Cmd") return "Command";
  if (part === "Ctrl") return "Control";
  if (part === "Option") return "Alt";
  if (part === "Meta") return mac ? "Command" : "Super";
  return part;
};

/** null for anything that isn't one real key with at least one non-Shift modifier. */
export const parseShortcut = (value: string, mac: boolean): ParsedShortcut | null => {
  const parts = value.split("+");
  if (parts.length < 2 || parts.length > 5) return null;
  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  if (!KEY.test(key) || !modifiers.every((part) => MODIFIER.test(part))) return null;
  const set = new Set(modifiers.map((part) => canonicalModifier(part, mac)));
  if (set.size !== modifiers.length || [...set].every((part) => part === "Shift")) return null;
  return {
    command: set.has("Command"),
    control: set.has("Control"),
    alt: set.has("Alt"),
    shift: set.has("Shift"),
    super: set.has("Super"),
    key: key === "Enter" ? "Return" : key,
  };
};

/** One spelling per shortcut ("Shift+CmdOrCtrl+k" and "Command+Shift+K" are the same). */
export const canonicalShortcut = (value: string, mac: boolean): string | null => {
  if (value === FN_KEY) return FN_KEY;
  const parsed = parseShortcut(value.replace(/\+([a-z])$/, (_, letter: string) => `+${letter.toUpperCase()}`), mac);
  if (!parsed) return null;
  const parts = MODIFIER_ORDER.filter((name) => parsed[name.toLowerCase() as keyof ParsedShortcut]);
  return [...parts, parsed.key].join("+");
};

/** The accelerator key for a physical key (event.code), the same on every keyboard layout. */
export const keyForCode = (code: string): string | null => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] ?? null;
};
const CODE_KEYS: Record<string, string> = {
  Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Enter: "Return", NumpadEnter: "Return",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown", Escape: "Escape", Minus: "-", Equal: "=", BracketLeft: "[",
  BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
};

/** Whether a key press is this binding: exactly its modifiers, and its physical key. */
export const matchesShortcut = (
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">,
  binding: string,
  mac: boolean
): boolean => {
  const parsed = binding === FN_KEY ? null : parseShortcut(binding, mac);
  if (!parsed) return false;
  const meta = mac ? parsed.command : parsed.super;
  return event.metaKey === meta
    && event.ctrlKey === parsed.control
    && event.altKey === parsed.alt
    && event.shiftKey === parsed.shift
    && keyForCode(event.code) === parsed.key;
};

const MAC_CAPS: Record<string, string> = {
  Command: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Return: "↩", Backspace: "⌫", Delete: "⌦",
  Up: "↑", Down: "↓", Left: "←", Right: "→", Tab: "⇥", Escape: "⎋", Space: "Space",
};
const OTHER_CAPS: Record<string, string> = {
  Control: "Ctrl", Super: "Win", Up: "↑", Down: "↓", Left: "←", Right: "→", Return: "Enter", Escape: "Esc",
};

/** The keycaps a binding is drawn with: ["⌘", "K"], or ["Fn"]. */
export const shortcutKeycaps = (binding: string, mac: boolean): string[] => {
  if (binding === FN_KEY) return [mac ? "🌐 Fn" : "Fn"];
  const canonical = canonicalShortcut(binding, mac);
  if (!canonical) return [binding];
  return canonical.split("+").map((part) => (mac ? MAC_CAPS : OTHER_CAPS)[part] ?? part);
};

/** One line of text for hints and tooltips: "⌘D" on a Mac, "Ctrl+D" elsewhere. */
export const shortcutText = (binding: string, mac: boolean): string =>
  shortcutKeycaps(binding, mac).join(mac ? "" : "+");

