import { useEffect, useRef, type RefObject } from "react";

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
    const mac = /Mac/.test(navigator.platform);
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
      const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (
        event.key.toLowerCase() !== "d" ||
        !modifier ||
        event.shiftKey ||
        event.altKey ||
        !voice.available
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || voice.state === "processing") return;
      if (voice.active) voice.stop();
      else {
        pressedAt = Date.now();
        voice.start();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "d" || event.key === (mac ? "Meta" : "Control")) release();
    };
    document.addEventListener("keydown", down, true);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);
}
