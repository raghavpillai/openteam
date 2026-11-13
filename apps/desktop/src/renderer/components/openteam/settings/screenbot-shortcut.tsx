import { Button } from "../../ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SectionLabel,
  SettingsGroup,
  SettingsReveal,
  SettingsRow,
  SkeletonBar,
  SkeletonControl,
  SkeletonText,
  settingsSecondaryButton,
} from "./ui";

type Shortcut = ScreenBotShortcutView;
type Status = ScreenBotShortcutStatusView;

const mac = () => window.openteam?.platform === "darwin";

const MODIFIER_CODES = {
  command: ["MetaLeft", "MetaRight"],
  option: ["AltLeft", "AltRight"],
  shift: ["ShiftLeft", "ShiftRight"],
  control: ["ControlLeft", "ControlRight"],
} as const;
const MODIFIER_SYMBOL = { command: "⌘", option: "⌥", shift: "⇧", control: "⌃" } as const;
const MODIFIER_NAME = {
  command: "Command",
  option: "Option",
  shift: "Shift",
  control: "Control",
} as const;

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Enter: "Return",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
};

/** The Electron accelerator key for a physical key, independent of layout and Option. */
const acceleratorKey = (code: string): string | null => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return KEY_NAMES[code] ?? null;
};

const KEYCAP: Record<string, string> = {
  Command: "⌘",
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Return: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Tab: "⇥",
  Space: "Space",
  Escape: "⎋",
};

const keycap = (part: string) => {
  if (part === "CommandOrControl" || part === "CmdOrCtrl") return mac() ? "⌘" : "Ctrl";
  if (!mac()) return part === "Super" ? "Win" : part === "Control" ? "Ctrl" : part;
  return KEYCAP[part] ?? part;
};

export const shortcutKeycaps = (shortcut: Shortcut): string[] =>
  shortcut.kind === "chord"
    ? [MODIFIER_SYMBOL[shortcut.modifier], MODIFIER_SYMBOL[shortcut.modifier]]
    : shortcut.accelerator.split("+").map(keycap);

export const describeShortcut = (shortcut: Shortcut): string =>
  shortcut.kind === "chord"
    ? `Both ${MODIFIER_NAME[shortcut.modifier]} keys`
    : shortcutKeycaps(shortcut).join(mac() ? "" : "+");

/** While a shortcut is recorded: the keys held so far as keycaps, or a keycap-sized prompt. */
export function RecordingKeys({ keys }: { keys: string[] }) {
  return keys.length ? (
    <Keycaps keys={keys} chord={false} />
  ) : (
    <span className="inline-flex h-[22px] items-center rounded-[6px] border border-dashed border-[var(--control-accent)] px-2 text-[12px] leading-none text-[var(--control-accent)]">
      Type shortcut
    </span>
  );
}

export function Keycaps({ keys, chord }: { keys: string[]; chord: boolean }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {keys.map((key, index) => (
        <span key={index} className="inline-flex items-center gap-1">
          {chord && index > 0 && <span className="text-[11px] text-foreground-tertiary">+</span>}
          <kbd className="inline-grid h-[22px] min-w-[22px] place-items-center rounded-[6px] border border-black/[0.08] bg-background px-1.5 font-sans text-[12px] leading-none text-foreground shadow-[0_1px_0_rgba(0,0,0,0.08)] dark:border-white/[0.1]">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

// Asked for as soon as this code loads (Settings preloads it on open) and kept between
// visits, so the section renders complete instead of growing a row after it appears.
let lastStatus: Status | null = null;
void window.openteam?.screenbot?.shortcut
  ?.get()
  .then((next) => {
    lastStatus ??= next;
  })
  .catch(() => undefined);

/** Settings › Keyboard › ScreenBot: the shortcut, with Change and Reset. */
export function ScreenBotShortcutSettings() {
  const bridge = window.openteam?.screenbot?.shortcut;
  const [status, setStatus] = useState<Status | null>(() => lastStatus);
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const pressed = useRef(new Set<string>());
  useEffect(() => {
    if (status) lastStatus = status;
  }, [status]);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.get().then((next) => {
      if (active) setStatus(next);
    });
    const stop = bridge.onChange((next) =>
      setStatus((current) => (current ? { ...current, ...next } : next))
    );
    return () => {
      active = false;
      stop();
    };
  }, [bridge]);

  const finish = useCallback(
    async (shortcut: Shortcut | null) => {
      pressed.current.clear();
      setHeld([]);
      setRecording(false);
      await bridge?.setRecording(false);
      if (!shortcut || !bridge) return;
      try {
        setStatus(await bridge.set(shortcut));
        setError(null);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
            : "That shortcut can’t be used."
        );
      }
    },
    [bridge]
  );

  useEffect(() => {
    if (!recording) return;
    const onDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      pressed.current.add(event.code);
      const keys = pressed.current;
      if (mac()) {
        for (const [modifier, [left, right]] of Object.entries(MODIFIER_CODES)) {
          if (keys.has(left) && keys.has(right)) {
            void finish({ kind: "chord", modifier: modifier as keyof typeof MODIFIER_CODES });
            return;
          }
        }
      }
      const modifiers = [
        event.metaKey && (mac() ? "Command" : "Super"),
        event.ctrlKey && (mac() ? "Control" : "CommandOrControl"),
        event.altKey && "Alt",
        event.shiftKey && "Shift",
      ].filter(Boolean) as string[];
      setHeld(modifiers);
      // Before the key lookup: Escape has no accelerator name, and must still cancel.
      if (event.key === "Escape" && modifiers.length === 0) {
        void finish(null);
        return;
      }
      const key = acceleratorKey(event.code);
      if (!key) return;
      if (modifiers.some((part) => part !== "Shift")) {
        void finish({ kind: "accelerator", accelerator: [...modifiers, key].join("+") });
      } else {
        setError(
          mac() ? "Include ⌘, ⌃ or ⌥, or press both keys of one modifier." : "Include Ctrl or Alt."
        );
      }
    };
    const onUp = (event: KeyboardEvent) => {
      event.preventDefault();
      pressed.current.delete(event.code);
      setHeld(
        [
          event.metaKey && (mac() ? "Command" : "Super"),
          event.ctrlKey && (mac() ? "Control" : "CommandOrControl"),
          event.altKey && "Alt",
          event.shiftKey && "Shift",
        ].filter(Boolean) as string[]
      );
    };
    const cancel = () => void finish(null);
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", cancel);
    };
  }, [finish, recording]);

  // Leaving Settings mid-recording must not leave the shortcut paused.
  useEffect(
    () => () => {
      void bridge?.setRecording(false);
    },
    [bridge]
  );

  if (!bridge) return null;
  if (!status) {
    return (
      <>
        <SectionLabel>ScreenBot</SectionLabel>
        <SettingsGroup>
          <SettingsRow
            title="Shortcut"
            description={<SkeletonText width={318} />}
            control={
              <div
                aria-label="Loading the ScreenBot shortcut"
                className="flex items-center gap-2"
                role="status"
              >
                <span className="flex gap-1 px-1.5 py-1">
                  <SkeletonBar className="h-[22px] w-[22px] rounded-[6px]" />
                  <SkeletonBar className="h-[22px] w-[22px] rounded-[6px]" />
                </span>
                <SkeletonControl width={67} />
                <SkeletonControl width={52} />
              </div>
            }
          />
        </SettingsGroup>
      </>
    );
  }
  const chord = status.shortcut.kind === "chord";
  const preview = held.map(keycap);
  const needsAccess = chord && status.mode === "poll";

  return (
    <>
      <SectionLabel>ScreenBot</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          title="Shortcut"
          description={
            recording ? (
              mac() ? (
                "Press a shortcut, or both keys of one modifier, like both ⌘ keys. Esc cancels."
              ) : (
                "Press a shortcut. Esc cancels."
              )
            ) : (
              <SettingsReveal>{`Press ${describeShortcut(status.shortcut).replace(/^Both/, "both")} to capture your screen and send it to a Bot.`}</SettingsReveal>
            )
          }
          control={
            <div className="flex items-center gap-2">
              <span
                aria-live="polite"
                aria-label={
                  recording
                    ? "Recording a shortcut"
                    : `Current shortcut: ${describeShortcut(status.shortcut)}`
                }
                className="px-1.5 py-1"
              >
                {recording ? (
                  <RecordingKeys keys={preview} />
                ) : (
                  <Keycaps keys={shortcutKeycaps(status.shortcut)} chord={chord} />
                )}
              </span>
              <Button
                size="xs"
                variant="secondary"
                type="button"
                className={settingsSecondaryButton}
                onClick={() => {
                  if (recording) void finish(null);
                  else {
                    setError(null);
                    pressed.current.clear();
                    setRecording(true);
                    void bridge.setRecording(true);
                  }
                }}
              >
                {recording ? "Cancel" : "Change…"}
              </Button>
              <Button
                size="xs"
                variant="secondary"
                type="button"
                className={settingsSecondaryButton}
                disabled={status.isDefault || recording}
                title="Reset to both ⌘ keys"
                onClick={() =>
                  void bridge.reset().then((next) => {
                    setStatus(next);
                    setError(null);
                  })
                }
              >
                Reset
              </Button>
            </div>
          }
        />
        {(error || status.error || needsAccess) && (
          <div className="flex items-center gap-3 border-t border-black/[0.065] py-2.5 text-[12px] leading-4 text-foreground-secondary dark:border-white/[0.07]">
            <span className={error || status.error ? "text-[#d70015] dark:text-[#ff6961]" : ""}>
              {error ??
                status.error ??
                "If pressing both keys does nothing, allow OpenTeam in Input Monitoring."}
            </span>
            {!error && !status.error && needsAccess && (
              <Button
                size="xs"
                variant="secondary"
                type="button"
                className={`${settingsSecondaryButton} ml-auto`}
                disabled={asking}
                onClick={() => {
                  setAsking(true);
                  void bridge.requestAccess().finally(() => setAsking(false));
                }}
              >
                Allow…
              </Button>
            )}
          </div>
        )}
      </SettingsGroup>
    </>
  );
}
