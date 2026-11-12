import { useEffect, useRef, type RefObject } from "react";
import { FN_KEY, parseShortcut } from "../lib/keyboard-shortcuts";
import { isMac, isShortcut, shortcutBinding } from "./use-shortcut-bindings";

export function useVoiceShortcuts(options: {
  editor: RefObject<HTMLDivElement | null>;
  available: boolean;
  active: boolean;
  state: string;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  sendWhenReady: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const mac = isMac();
    let pressedAt: number | null = null;
    const release = () => {
      const started = pressedAt;
      pressedAt = null;
      if (started !== null && Date.now() - started >= 500) {
        const voice = latest.current;
        if (voice.state === "recording" || voice.state === "requesting") voice.stop();
      }
    };
    const down = (event: KeyboardEvent) => {
      const voice = latest.current;
      const editor = voice.editor.current;
      const inComposer = editor?.closest("form")?.contains(event.target as Node);
      if (!inComposer || event.isComposing) return;
      if (event.key === "Escape" && voice.active) {
        event.preventDefault();
        event.stopPropagation();
        pressedAt = null;
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
      if (event.repeat || voice.state === "processing") return;
      if (voice.active) voice.stop();
      else {
        pressedAt = Date.now();
        voice.start();
      }
    };
    // Held past half a second, letting go stops the recording (push to talk): on the binding's
    // key, or any of its modifiers.
    const up = (event: KeyboardEvent) => {
      const binding = parseShortcut(shortcutBinding("dictate"), mac);
      if (!binding) return;
      const modifier = (binding.command && event.key === "Meta") || (binding.control && event.key === "Control")
        || (binding.alt && event.key === "Alt") || (binding.shift && event.key === "Shift") || (binding.super && event.key === "Meta");
      if (modifier || event.code.replace(/^Key|^Digit/, "") === binding.key || event.code === `Arrow${binding.key}`) release();
    };
    // Fn on its own only reaches main (through the native helper), which forwards it here.
    const stopFn = window.openteam?.shortcuts?.onShortcut((action) => {
      const voice = latest.current;
      if (action !== "fn" || shortcutBinding("dictate") !== FN_KEY || !voice.available) return;
      // Only the composer on screen, and only when focus is in it (or nowhere in particular):
      // other conversations keep theirs mounted while hidden.
      const editor = voice.editor.current;
      if (!editor?.isConnected || editor.offsetParent === null || !document.hasFocus()) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && !editor.closest("form")?.contains(focused)) return;
      if (voice.state === "processing") return;
      if (voice.active) voice.stop();
      else voice.start();
    });
    document.addEventListener("keydown", down, true);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      stopFn?.();
    };
  }, []);
}
