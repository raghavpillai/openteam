import { Mic, Square } from "lucide-react";

/** Inserts dictated text at the caret, with a space where it meets other words. */
export function insertDictation(value: string, start: number, end: number, spoken: string) {
  const words = spoken.trim();
  if (!words) return { value, caret: end };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s.,!?;:]/.test(after) ? " " : "";
  const inserted = `${lead}${words}${trail}`;
  return { value: `${before}${inserted}${after}`, caret: before.length + lead.length + words.length };
}

export function DictationButton({
  state,
  disabled,
  onStart,
  onStop,
  shortcut = "⌘D",
}: {
  state: "idle" | "requesting" | "recording" | "processing" | "error";
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  shortcut?: string;
}) {
  const recording = state === "recording" || state === "requesting";
  return (
    <button
      type="button"
      className="appshot-mic"
      data-state={state}
      disabled={disabled || state === "processing"}
      aria-label={recording ? "Stop dictation and insert text" : `Dictate (${shortcut})`}
      aria-pressed={recording}
      title={recording ? "Stop (↩)" : `Dictate (${shortcut})`}
      onClick={recording ? onStop : onStart}
    >
      {recording ? <Square size={10} strokeWidth={0} fill="currentColor" /> : <Mic size={15} strokeWidth={2.2} />}
    </button>
  );
}
