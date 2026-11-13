import { useEffect, useRef, type RefObject } from "react";
import { FN_KEY } from "../lib/keyboard-shortcuts";
import { createDictateGesture, MIC_STILL_STARTING, releasesDictate } from "./dictate-gesture";
import { isShortcut, shortcutBinding } from "./use-shortcut-bindings";

/**
 * Whether the Dictate shortcut belongs to this composer: the one on screen (hidden
 * conversations keep theirs mounted), with no other dialog in front and no other text field
 * focused.
 */
const dictateHere = (editor: HTMLElement | null, focused: EventTarget | Element | null) => {
  if (!editor?.isConnected || editor.offsetParent === null) return false;
  // A dialog in front (Search, Settings) owns the keys, unless the composer is in it: a file
  // preview carries the chat composer along.
  const dialogs = [...document.querySelectorAll("[role=dialog]")];
  if (dialogs.length && !dialogs.some((dialog) => dialog.contains(editor))) return false;
  if (!(focused instanceof Element) || focused === document.body || editor.closest("form")?.contains(focused)) return true;
  return !focused.closest("input, textarea, select, [contenteditable=true]");
};

export function useVoiceShortcuts(options: {
  editor: RefObject<HTMLDivElement | null>;
  available: boolean;
  active: boolean;
  state: string;
  elapsedMs: number;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  fail: (message: string) => void;
  sendWhenReady: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    // Hold to dictate, or press twice to keep dictating (dictate-gesture.ts).
    const gesture = createDictateGesture({
      state: () => latest.current.state,
      active: () => latest.current.state === "recording" || latest.current.state === "requesting",
      start: () => latest.current.start(),
      stop: () => latest.current.stop(),
      cancel: () => latest.current.cancel(),
      elapsedMs: () => latest.current.elapsedMs,
      tooEarly: () => latest.current.fail(MIC_STILL_STARTING),
    });
    const release = () => gesture.release();
    const down = (event: KeyboardEvent) => {
      const voice = latest.current;
      const editor = voice.editor.current;
      const inComposer = editor?.closest("form")?.contains(event.target as Node);
      // Dictate works anywhere in the conversation, not only with the composer focused.
      if (!inComposer && isShortcut(event, "dictate") && voice.available && dictateHere(editor, event.target)) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          editor?.focus();
          gesture.press();
        }
        return;
      }
      if (!inComposer || event.isComposing) return;
      if (event.key === "Escape" && voice.active) {
        event.preventDefault();
        event.stopPropagation();
        gesture.reset();
        voice.cancel();
        return;
      }
      if (event.target !== editor) return;
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        voice.active
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          if (voice.state === "recording") voice.stop();
          else if (voice.state === "processing") voice.sendWhenReady();
        }
        return;
      }
      if (!isShortcut(event, "dictate") || !voice.available) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) gesture.press();
    };
    const up = (event: KeyboardEvent) => {
      if (releasesDictate(event)) release();
    };
    // Fn on its own only reaches main (through the native helper), which forwards it here.
    const stopFn = window.openteam?.shortcuts?.onShortcut((action) => {
      const voice = latest.current;
      if (!action.startsWith("fn-") || shortcutBinding("dictate") !== FN_KEY || !voice.available) return;
      const editor = voice.editor.current;
      if (!document.hasFocus() || !dictateHere(editor, document.activeElement)) return;
      if (action === "fn-down") {
        editor?.focus();
        gesture.press();
      }
      else if (action === "fn-up") gesture.release();
      else if (action === "fn-cancel") gesture.abort();
    });
    document.addEventListener("keydown", down, true);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      stopFn?.();
      gesture.reset();
    };
  }, []);
}
