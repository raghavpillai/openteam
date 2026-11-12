import { useSyncExternalStore } from "react";
import {
  defaultShortcutBindings,
  matchesShortcut,
  type ShortcutAction,
  type ShortcutBindings,
} from "../lib/keyboard-shortcuts";

// The window's copy of the app's shortcut bindings: defaults until main answers, then kept in
// step with every change. Shared by the chat window and the screenbot overlay.
const source = () => window.openteam?.shortcuts ?? window.screenbot?.shortcuts;
let bindings: ShortcutBindings = defaultShortcutBindings();
const listeners = new Set<() => void>();
let started = false;
const update = (view: KeyboardShortcutsView | undefined) => {
  if (!view?.bindings) return;
  bindings = { ...defaultShortcutBindings(), ...view.bindings };
  for (const listener of listeners) listener();
};
const start = () => {
  if (started) return;
  started = true;
  const bridge = source();
  if (!bridge) return;
  void bridge.get().then(update, () => undefined);
  bridge.onChange(update);
};

export const isMac = () => /Mac/.test(navigator.platform);

/** The current binding, for key handlers (always fresh, no re-render needed). */
export const shortcutBinding = (action: ShortcutAction): string => {
  start();
  return bindings[action];
};

/** Whether this key press is the action's shortcut. */
export const isShortcut = (event: KeyboardEvent | React.KeyboardEvent, action: ShortcutAction) =>
  matchesShortcut(event, shortcutBinding(action), isMac());

/** All bindings, re-rendering when one changes (for hints and Settings). */
export function useShortcutBindings(): ShortcutBindings {
  start();
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => bindings,
    () => bindings
  );
}
