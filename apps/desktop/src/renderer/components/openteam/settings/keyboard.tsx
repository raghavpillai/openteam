import { useCallback, useEffect, useState } from "react";
import { useShortcutBindings, isMac } from "../../../hooks/use-shortcut-bindings";
import {
  canonicalShortcut,
  defaultShortcutBindings,
  FN_KEY,
  keyForCode,
  SHORTCUT_ACTIONS,
  shortcutKeycaps,
  shortcutText,
  type ShortcutAction,
} from "../../../lib/keyboard-shortcuts";
import {
  checkShortcut,
  SHORTCUT_LABELS,
} from "../../../lib/keyboard-shortcut-rules";
import { AppshotShortcutSettings, Keycaps } from "./appshot-shortcut";
import { SectionLabel, SettingsGroup, SettingsRow, settingsSecondaryButton } from "./ui";

const errorText = (cause: unknown) =>
  cause instanceof Error
    ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
    : "That shortcut can’t be used.";

const HELD_MAC: Record<string, string> = { Command: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };
const HELD_OTHER: Record<string, string> = { Control: "Ctrl", Super: "Win" };

const heldModifiers = (event: KeyboardEvent, mac: boolean) =>
  [
    mac && event.metaKey && "Command",
    event.ctrlKey && "Control",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    !mac && event.metaKey && "Super",
  ].filter(Boolean) as string[];

/** One rebindable shortcut: its keycaps, Change… (records the next shortcut pressed) and Reset. */
function ShortcutRow({
  action,
  recording,
  onRecord,
}: {
  action: ShortcutAction;
  recording: boolean;
  onRecord: (action: ShortcutAction | null) => void;
}) {
  const mac = isMac();
  const bindings = useShortcutBindings();
  const binding = bindings[action];
  const fallback = defaultShortcutBindings()[action];
  const [held, setHeld] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isDefault = canonicalShortcut(binding, mac) === canonicalShortcut(fallback, mac);

  const save = useCallback(async (value: string | null) => {
    onRecord(null);
    setHeld([]);
    if (value !== null) {
      // Checked here first for an instant answer; main checks again before saving.
      const problem = checkShortcut(action, value, bindings, mac);
      if (problem) {
        setError(problem);
        return;
      }
    }
    try {
      await window.openteam?.shortcuts?.set(action, value);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [action, bindings, mac, onRecord]);

  useEffect(() => {
    if (!recording) return;
    setError(null);
    // Capture before anything else in the window, so the key being recorded doesn't also act.
    const onDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const modifiers = heldModifiers(event, mac);
      setHeld(modifiers);
      if (event.key === "Escape" && modifiers.length === 0) {
        onRecord(null);
        setHeld([]);
        return;
      }
      const key = keyForCode(event.code);
      if (!key) return;
      if (!modifiers.some((part) => part !== "Shift")) {
        setError(mac ? "Include ⌘, ⌃ or ⌥ with a key." : "Include Ctrl or Alt with a key.");
        return;
      }
      void save([...modifiers, key].join("+"));
    };
    const onUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      setHeld(heldModifiers(event, mac));
    };
    const cancel = () => {
      onRecord(null);
      setHeld([]);
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", cancel);
    };
  }, [mac, onRecord, recording, save]);

  const label = SHORTCUT_LABELS[action];
  const fnOffer = action === "dictate" && mac && binding !== FN_KEY;
  const description = recording
    ? `Press the new shortcut${action === "dictate" && mac ? " (or use Fn on its own)" : ""}. Esc cancels.`
    : action === "dictate" && binding === FN_KEY
      ? "Tap 🌐 Fn on its own to start or stop a voice note. If macOS also reacts, set “Press 🌐 key to” to “Do Nothing” in System Settings › Keyboard."
      : label.description;

  return (
    <>
      <SettingsRow
        title={label.title}
        description={description}
        control={
          <div className="flex items-center gap-2">
            <span
              aria-live="polite"
              aria-label={recording ? `Recording a shortcut for ${label.title}` : `${label.title}: ${shortcutText(binding, mac)}`}
              className={recording ? "rounded-[8px] px-1.5 py-1 ring-2 ring-[var(--control-accent)]" : "px-1.5 py-1"}
            >
              {recording ? (
                held.length ? <Keycaps keys={held.map((part) => (mac ? HELD_MAC : HELD_OTHER)[part] ?? part)} chord={false} /> : <span className="text-[12px] text-foreground-secondary">Recording…</span>
              ) : (
                <Keycaps keys={shortcutKeycaps(binding, mac)} chord={false} />
              )}
            </span>
            {fnOffer && (
              <button type="button" className={settingsSecondaryButton} title="Dictate with the 🌐 Fn key on its own" onClick={() => void save(FN_KEY)}>
                Use Fn
              </button>
            )}
            <button type="button" className={settingsSecondaryButton} onClick={() => onRecord(recording ? null : action)}>
              {recording ? "Cancel" : "Change…"}
            </button>
            <button
              type="button"
              className={settingsSecondaryButton}
              disabled={isDefault || recording}
              title={`Reset to ${shortcutText(fallback, mac)}`}
              onClick={() => void save(null)}
            >
              Reset
            </button>
          </div>
        }
      />
      {error && (
        <div role="alert" className="border-t border-black/[0.065] py-2.5 text-[12px] leading-4 text-[#d70015] dark:border-white/[0.07] dark:text-[#ff6961]">
          {error}
        </div>
      )}
    </>
  );
}

/** Settings › Keyboard: the appshot trigger, and the app's own shortcuts. */
export default function KeyboardSettings() {
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const appshot = window.openteam?.appshot?.shortcut;
  // While a shortcut is recorded, the global ones (the appshot trigger, Fn) must not act.
  useEffect(() => {
    void appshot?.setRecording(recording !== null);
  }, [appshot, recording]);
  useEffect(() => () => { void appshot?.setRecording(false); }, [appshot]);

  return (
    <>
      {window.openteam?.appshot && <AppshotShortcutSettings />}
      <SectionLabel>Shortcuts</SectionLabel>
      <SettingsGroup>
        {SHORTCUT_ACTIONS.map((action) => (
          <ShortcutRow key={action} action={action} recording={recording === action} onRecord={setRecording} />
        ))}
      </SettingsGroup>
    </>
  );
}
