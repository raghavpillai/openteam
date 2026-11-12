import { useEffect, useRef, type RefObject } from "react";
import { FN_KEY } from "../lib/keyboard-shortcuts";
import { createDictateGesture, releasesDictate } from "./dictate-gesture";
import { isShortcut, shortcutBinding } from "./use-shortcut-bindings";

export function useVoiceShortcuts(options: {
  editor: RefObject<HTMLDivElement | null>;
  available: boolean;
  active: boolean;
  state: string;
  elapsedMs: number;
  start: () => void;
  stop: () => void;
  cancel: () => void;
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
    });
    const release = () => gesture.release();
    const down = (event: KeyboardEvent) => {
      const voice = latest.current;
      const editor = voice.editor.current;
      const inComposer = editor?.closest("form")?.contains(event.target as Node);
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
      // Only the composer on screen, and only when focus is in it (or nowhere in particular):
      // other conversations keep theirs mounted while hidden.
      const editor = voice.editor.current;
      if (!editor?.isConnected || editor.offsetParent === null || !document.hasFocus()) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && !editor.closest("form")?.contains(focused)) return;
      if (action === "fn-down") gesture.press();
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
