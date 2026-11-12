import { MIN_VOICE_NOTE_MS } from "@openteam/contracts/transcription";
import { FN_KEY, parseShortcut } from "../lib/keyboard-shortcuts";
import { isMac, shortcutBinding } from "./use-shortcut-bindings";

/** A press shorter than this is a tap (half of a double press), not a hold. */
export const DICTATE_TAP_MS = 300;
/** How soon the second press of a double press must come. */
export const DICTATE_DOUBLE_MS = 350;

export interface DictateTarget {
  state(): string;
  /** Recording, or about to (the microphone is being opened). */
  active(): boolean;
  start(): void;
  stop(): void;
  cancel(): void;
  elapsedMs(): number;
}

/**
 * The Dictate shortcut, whatever it's bound to (⌘D, Fn, a combination…), the same in the chat
 * composer and ScreenBot:
 *
 * - Hold it: records while held; letting go transcribes.
 * - Press it twice quickly: keeps recording, hands-free, until it's pressed again.
 *
 * The first press starts the microphone at once (a hold needs it); released quickly, the
 * recording waits a moment for the second press and is dropped quietly if none comes.
 */
export function createDictateGesture(target: DictateTarget) {
  let mode: "idle" | "holding" | "waiting" | "handsFree" = "idle";
  let pressedAt = 0;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const clearWait = () => {
    if (waitTimer) clearTimeout(waitTimer);
    waitTimer = undefined;
  };
  // Stopping under the minimum would only report "too short": drop it quietly instead.
  const finish = () => {
    if (target.state() === "requesting" || target.elapsedMs() < MIN_VOICE_NOTE_MS) target.cancel();
    else target.stop();
  };

  return {
    press() {
      // Esc, an error or the mic button may have ended it meanwhile.
      if (mode !== "idle" && mode !== "holding" && !target.active()) {
        clearWait();
        mode = "idle";
      }
      if (mode === "handsFree") {
        mode = "idle";
        finish();
        return;
      }
      if (mode === "waiting") {
        // The second press: keep going, hands-free.
        clearWait();
        mode = "handsFree";
        return;
      }
      if (mode === "holding" || target.state() === "processing") return;
      if (target.active()) {
        // Started another way (the mic button): the shortcut ends it.
        finish();
        return;
      }
      mode = "holding";
      pressedAt = Date.now();
      target.start();
    },
    release() {
      if (mode !== "holding") return;
      if (Date.now() - pressedAt >= DICTATE_TAP_MS) {
        mode = "idle";
        finish();
        return;
      }
      mode = "waiting";
      waitTimer = setTimeout(() => {
        waitTimer = undefined;
        if (mode !== "waiting") return;
        mode = "idle";
        if (target.active()) target.cancel();
      }, DICTATE_DOUBLE_MS);
    },
    /** The press turned out to be something else (Fn with another key): undo it quietly. */
    abort() {
      if (mode !== "holding") return;
      mode = "idle";
      if (target.active()) target.cancel();
    },
    reset() {
      clearWait();
      mode = "idle";
    },
  };
}

/** Whether a key-up ends a hold of the Dictate shortcut: its key, or any of its modifiers. */
export const releasesDictate = (event: KeyboardEvent) => {
  const binding = shortcutBinding("dictate");
  if (binding === FN_KEY) return false;
  const parsed = parseShortcut(binding, isMac());
  if (!parsed) return false;
  const modifier = (parsed.command && event.key === "Meta") || (parsed.control && event.key === "Control")
    || (parsed.alt && event.key === "Alt") || (parsed.shift && event.key === "Shift") || (parsed.super && event.key === "Meta");
  const code = event.code.replace(/^Key|^Digit/, "").replace(/^Arrow/, "");
  return modifier || code === parsed.key;
};

/** Copy for hints: how the Dictate shortcut works. */
export const dictateHowTo = (keys: string) => `Hold ${keys} to dictate, or press it twice to keep dictating until you press it again.`;
