import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

export const CHORD_MODIFIERS = ["command", "option", "shift", "control"] as const;
export type ChordModifier = (typeof CHORD_MODIFIERS)[number];

/** Either both keys of one modifier (left and right) or an ordinary global shortcut. */
export type ScreenBotShortcut =
  | { kind: "chord"; modifier: ChordModifier }
  | { kind: "accelerator"; accelerator: string };

export interface ScreenBotShortcutStatus {
  shortcut: ScreenBotShortcut;
  isDefault: boolean;
  /** The shortcut is listening right now. */
  active: boolean;
  /** How a chord is detected: a passive event tap (Input Monitoring) or the modifier state. */
  mode: "tap" | "poll" | "shortcut" | null;
  error: string | null;
  /** The helper is running and watching the Fn key (dictation is bound to it). */
  fn: boolean;
}

export const defaultScreenBotShortcut = (platform: NodeJS.Platform): ScreenBotShortcut =>
  platform === "darwin"
    ? { kind: "chord", modifier: "command" }
    : { kind: "accelerator", accelerator: "CommandOrControl+Shift+2" };

const MODIFIER = /^(?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|AltGr|Shift|Super|Meta)$/;
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Plus|[`\-=[\];',./\\])$/;

/** An accelerator with a real key and at least one modifier other than Shift. */
export const isValidAccelerator = (value: string): boolean => {
  const parts = value.split("+");
  if (parts.length < 2 || parts.length > 5) return false;
  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  return KEY.test(key)
    && modifiers.every((part) => MODIFIER.test(part))
    && new Set(modifiers).size === modifiers.length
    && modifiers.some((part) => part !== "Shift");
};

const MODIFIER_ORDER = ["Command", "Control", "Alt", "Shift", "Super"];
const canonicalModifier = (part: string, platform: NodeJS.Platform) => {
  if (part === "CommandOrControl" || part === "CmdOrCtrl") return platform === "darwin" ? "Command" : "Control";
  if (part === "Cmd") return "Command";
  if (part === "Ctrl") return "Control";
  if (part === "Option" || part === "AltGr") return "Alt";
  if (part === "Meta") return platform === "darwin" ? "Command" : "Super";
  return part;
};
/** "Shift+CmdOrCtrl+c" → "Command+Shift+C" (macOS), so equivalent spellings compare equal. */
const canonicalAccelerator = (value: string, platform: NodeJS.Platform) => {
  const parts = value.split("+");
  const key = parts.at(-1)!.toUpperCase();
  const modifiers = [...new Set(parts.slice(0, -1).map((part) => canonicalModifier(part, platform)))]
    .sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...modifiers, key].join("+");
};

// Shortcuts people rely on in every app (and this app's own menu). A global shortcut takes
// the key from every app, so these would stop working everywhere.
const RESERVED_MAC = [
  ..."ACVXZSWQHMNTFPO".split("").map((key) => `Command+${key}`),
  "Command+TAB", "Command+SPACE", "Command+`", "Command+,", "Command+Shift+Z",
  "Command+Shift+3", "Command+Shift+4", "Command+Shift+5", "Command+Alt+ESCAPE",
  "Command+Control+Q", "Command+Control+F", "Command+Control+SPACE", "Control+SPACE",
];
const RESERVED_OTHER = [
  ..."ACVXZSWQNTFPOY".split("").map((key) => `Control+${key}`),
  "Control+,", "Alt+TAB", "Alt+F4", "Control+ESCAPE", "Control+Alt+DELETE", "Super+L", "Super+D", "Super+TAB",
];

/** Why an accelerator can't be the screenbot shortcut, or null when it can. */
export const reservedShortcutReason = (accelerator: string, platform: NodeJS.Platform): string | null => {
  const canonical = canonicalAccelerator(accelerator, platform);
  const reserved = new Set((platform === "darwin" ? RESERVED_MAC : RESERVED_OTHER).map((value) => canonicalAccelerator(value, platform)));
  if (reserved.has(canonical)) return "Other apps use that shortcut. Pick another.";
  // On Windows, Ctrl+Alt is AltGr: Ctrl+Alt+E would stop € from being typed anywhere.
  if (platform === "win32" && /^Control\+Alt\+[^+]+$/.test(canonical)) return "Ctrl+Alt shortcuts type characters on some keyboards. Pick another.";
  return null;
};

export const parseScreenBotShortcut = (value: unknown, platform: NodeJS.Platform): ScreenBotShortcut | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "chord") {
    // Modifier chords need the macOS helper.
    if (platform !== "darwin") return null;
    return CHORD_MODIFIERS.includes(candidate.modifier as ChordModifier)
      ? { kind: "chord", modifier: candidate.modifier as ChordModifier }
      : null;
  }
  if (
    candidate.kind === "accelerator" && typeof candidate.accelerator === "string"
    && isValidAccelerator(candidate.accelerator) && !reservedShortcutReason(candidate.accelerator, platform)
  ) {
    return { kind: "accelerator", accelerator: candidate.accelerator };
  }
  return null;
};

const sameShortcut = (left: ScreenBotShortcut, right: ScreenBotShortcut) =>
  left.kind === right.kind
  && (left.kind === "chord" ? left.modifier === (right as typeof left).modifier : left.accelerator === (right as typeof left).accelerator);

export interface ScreenBotShortcutOptions {
  platform: NodeJS.Platform;
  settingsPath: string;
  /** The modifier-chord helper; null where there is none (non-macOS). */
  helperPath: string | null;
  registerAccelerator: (accelerator: string, onPress: () => void) => boolean;
  unregisterAccelerator: (accelerator: string) => void;
  onTrigger: () => void;
  onStatus: (status: ScreenBotShortcutStatus) => void;
  /** The Fn key was tapped on its own (only while watching for it: dictation is bound to Fn). */
  onFn?: () => void;
}

/** Keeps the screenbot trigger listening: one helper process for chords, or a global shortcut. */
export class ScreenBotShortcutController {
  private shortcut: ScreenBotShortcut;
  private readonly fallback: ScreenBotShortcut;
  private helper: ChildProcessWithoutNullStreams | null = null;
  private helperMode: "tap" | "poll" | null = null;
  private registered: string | null = null;
  private recording = false;
  /** Dictation is bound to Fn, which only the helper can see. */
  private watchFn = false;
  private disposed = false;
  private error: string | null = null;
  private restarts: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Saves run one at a time, so the file and the live shortcut never disagree. */
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ScreenBotShortcutOptions) {
    this.fallback = defaultScreenBotShortcut(options.platform);
    this.shortcut = this.fallback;
  }

  async start() {
    try {
      const saved = JSON.parse(await readFile(this.options.settingsPath, "utf8")) as { shortcut?: unknown };
      this.shortcut = parseScreenBotShortcut(saved.shortcut, this.options.platform) ?? this.fallback;
    } catch {
      this.shortcut = this.fallback;
    }
    this.apply();
  }

  status(): ScreenBotShortcutStatus {
    const chord = this.shortcut.kind === "chord";
    return {
      shortcut: this.shortcut,
      isDefault: sameShortcut(this.shortcut, this.fallback),
      active: chord ? this.helperMode !== null : this.registered !== null,
      mode: chord ? this.helperMode : this.registered ? "shortcut" : null,
      error: this.error,
      fn: this.watchFn && this.helperMode !== null,
    };
  }

  /** Saves a new shortcut, or resets to the default with null. */
  set(value: unknown): Promise<ScreenBotShortcutStatus> {
    const next = value === null ? this.fallback : parseScreenBotShortcut(value, this.options.platform);
    if (!next) {
      const accelerator = (value as { accelerator?: unknown } | null)?.accelerator;
      const reason = typeof accelerator === "string" && isValidAccelerator(accelerator) ? reservedShortcutReason(accelerator, this.options.platform) : null;
      return Promise.reject(new Error(reason ?? "That shortcut can’t be used."));
    }
    const run = this.saving.then(async () => {
      await mkdir(dirname(this.options.settingsPath), { recursive: true });
      const temporary = `${this.options.settingsPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, shortcut: next }), { mode: 0o600 });
      await rename(temporary, this.options.settingsPath);
      // Only once it's saved does it become the live shortcut.
      this.shortcut = next;
      this.apply();
      return this.status();
    });
    this.saving = run.catch(() => undefined);
    return run;
  }

  /** The helper runs for a both-keys chord, or to watch the Fn key (macOS only). */
  private needsHelper() {
    return this.shortcut.kind === "chord" || this.watchFn;
  }

  /** Watch the Fn key on its own (dictation bound to Fn) or stop. */
  setWatchFn(watch: boolean) {
    if (this.watchFn === watch || this.options.platform !== "darwin") return;
    this.watchFn = watch;
    if (this.helper && !this.helper.killed) {
      if (this.needsHelper()) this.helper.stdin.write(`fn ${watch ? "on" : "off"}\n`);
      else this.stopHelper();
    } else if (this.needsHelper()) this.startHelper();
    this.options.onStatus(this.status());
  }

  /** A fresh helper: after Input Monitoring is granted it can use an idle event tap. */
  restartHelper() {
    if (!this.needsHelper()) return;
    this.stopHelper();
    this.error = null;
    this.restarts = [];
    this.startHelper();
    this.options.onStatus(this.status());
  }

  /** While Settings records a new shortcut, the current one must not take ScreenBots. */
  setRecording(recording: boolean) {
    if (this.recording === recording) return;
    this.recording = recording;
    // The helper's chord pauses (Fn still reports, to be recorded); an ordinary shortcut is
    // unregistered meanwhile.
    this.helper?.stdin.write(recording ? "pause\n" : "resume\n");
    if (this.shortcut.kind !== "chord") this.apply();
  }

  dispose() {
    this.disposed = true;
    this.clearRestart();
    this.stopHelper();
    if (this.registered) this.options.unregisterAccelerator(this.registered);
    this.registered = null;
  }

  private clearRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private apply() {
    if (this.disposed) return;
    this.clearRestart();
    this.error = null;
    if (this.registered) this.options.unregisterAccelerator(this.registered);
    this.registered = null;
    if (this.shortcut.kind === "chord") {
      if (this.helper && !this.helper.killed) this.helper.stdin.write(`chord ${this.shortcut.modifier}\n`);
      else this.startHelper();
    } else {
      // Still needed for Fn: keep it, without a chord.
      if (this.watchFn && this.helper && !this.helper.killed) this.helper.stdin.write("chord off\n");
      else if (this.watchFn) this.startHelper();
      else this.stopHelper();
      if (!this.recording) {
        const accelerator = this.shortcut.accelerator;
        if (this.options.registerAccelerator(accelerator, this.options.onTrigger)) this.registered = accelerator;
        else this.error = "Another app is using this shortcut.";
      }
    }
    this.options.onStatus(this.status());
  }

  private startHelper() {
    this.clearRestart();
    if (this.disposed || this.helper) return;
    if (!this.options.helperPath || !this.needsHelper()) {
      if (this.shortcut.kind === "chord") this.error = "Both-key shortcuts need macOS.";
      return;
    }
    const args = ["--chord", this.shortcut.kind === "chord" ? this.shortcut.modifier : "off", ...(this.watchFn ? ["--fn"] : [])];
    const child = spawn(this.options.helperPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.helper = child;
    this.helperMode = null;
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    if (this.recording) child.stdin.write("pause\n");
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line === "trigger") this.options.onTrigger();
      else if (line === "fn") this.options.onFn?.();
      else if (line === "ready tap" || line === "ready poll") {
        this.helperMode = line === "ready tap" ? "tap" : "poll";
        this.options.onStatus(this.status());
      }
    });
    // A helper that can't start (missing, not executable) emits "error" and never "exit":
    // treat it as an exit, or the dead child would look alive forever.
    let ended = false;
    const onEnd = (failedToStart: boolean) => {
      if (ended) return;
      ended = true;
      if (this.helper !== child) return;
      this.helper = null;
      this.helperMode = null;
      if (failedToStart) {
        // Missing or not executable: retrying won't help. Saving a shortcut tries again.
        this.error = "The shortcut listener couldn’t start.";
        this.options.onStatus(this.status());
        return;
      }
      if (this.disposed || !this.needsHelper()) return;
      // Restart a crashed listener, but stop if it keeps failing.
      const now = Date.now();
      this.restarts = [...this.restarts.filter((at) => now - at < 60_000), now];
      if (this.restarts.length > 4) {
        this.error = "The shortcut listener keeps stopping.";
        this.options.onStatus(this.status());
        return;
      }
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.disposed && this.needsHelper()) this.startHelper();
      }, 500 * this.restarts.length);
    };
    child.on("error", () => onEnd(true));
    child.on("exit", () => onEnd(false));
  }

  private stopHelper() {
    this.clearRestart();
    const child = this.helper;
    this.helper = null;
    this.helperMode = null;
    if (child && !child.killed) {
      child.stdin.end();
      child.kill();
    }
  }
}

/** Asks macOS for Input Monitoring through the helper, which owns the event tap. With
 * `check`, only reads the current state (no prompt). */
export const requestInputMonitoring = (helperPath: string, check = false): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn(helperPath, [check ? "--check-access" : "--request-access"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(output.trim() === "granted"));
  });
