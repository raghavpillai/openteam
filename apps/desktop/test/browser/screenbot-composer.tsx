import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ScreenBotBridge, ScreenBotRoster, ScreenBotSendResult, ScreenBotShot } from "../../src/renderer/screenbot/types";
import { defaultShortcutBindings } from "../../src/renderer/lib/keyboard-shortcuts";
import "../../src/renderer/screenbot/screenbot.css";

// The ScreenBot overlay's renderer with its preload bridge replaced. A send that a previous
// account started and that fails late must not put its words or error into the next
// account's composer; the same failure after a same-account retake must restore them.
type Listener<T> = (value: T) => void;
const listeners = { shot: new Set<Listener<ScreenBotShot>>(), roster: new Set<Listener<ScreenBotRoster>>(), reset: new Set<Listener<void>>() };
const on = <T,>(set: Set<Listener<T>>) => (callback: Listener<T>) => { set.add(callback); return () => set.delete(callback); };
const pending: Array<(result: ScreenBotSendResult) => void> = [];
const bindings = defaultShortcutBindings();
window.screenbot = {
  platform: "darwin",
  onShot: on(listeners.shot),
  onRoster: on(listeners.roster),
  onReset: on(listeners.reset),
  onHidden: () => () => {},
  ready() {}, setInteractive() {}, focus() {}, saveDraft() {}, close() {}, openChat() {},
  send: () => new Promise((resolve) => pending.push(resolve)),
  transcribe: async () => ({ ok: false, error: "No audio in this fixture" }),
  shortcuts: { get: async () => ({ bindings, defaults: bindings }) as never, onChange: () => () => {} },
  onShortcut: () => () => {},
} satisfies ScreenBotBridge;
const { ScreenBotApp } = await import("../../src/renderer/screenbot/screenbot-app");
const host = document.getElementById("root")!;
host.id = "screenbot-root";
createRoot(host).render(<StrictMode><ScreenBotApp /></StrictMode>);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => unknown, message: string) => {
  for (const start = performance.now(); !condition(); await pause(25))
    if (performance.now() - start > 8000) throw new Error(message);
};
const canvas = new OffscreenCanvas(64, 40);
canvas.getContext("2d")!.fillRect(0, 0, 64, 40);
const png = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
let version = 1;
const roster = (accountScope: string | null, name?: string): ScreenBotRoster => ({
  accountScope, dictation: false, theme: "light", version: version++,
  bots: name ? [{ id: name, name, title: "Fixture Bot", color: "blue", icon: "chip", channelId: `channel-${name}` }] : [],
});
const shot = (id: string, accountScope: string, name: string): ScreenBotShot => ({
  id, accountScope, image: png, width: innerWidth, height: innerHeight, offsetX: 0, offsetY: 0,
  workArea: { x: 0, y: 24, width: innerWidth, height: innerHeight - 24 },
  roster: roster(accountScope, name), rosterVersion: version++, draft: "",
});
const emit = <T,>(set: Set<Listener<T>>, value: T) => set.forEach((listener) => listener(value));
const input = () => document.querySelector<HTMLTextAreaElement>(".screenbot-input")!;
const sendButton = () => document.querySelector<HTMLButtonElement>(".screenbot-send");
const compose = async (next: ScreenBotShot, words?: string) => {
  emit(listeners.shot, next);
  await until(() => input() && document.querySelector(".screenbot-stage")?.getAttribute("data-phase") === "compose", "The composer never opened for " + next.id);
  if (words === undefined) return;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), words);
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => !sendButton()!.disabled, "Typing did not enable Send");
};
const startSend = async () => {
  const before = pending.length;
  sendButton()!.click();
  await until(() => pending.length > before, "Send never reached the bridge");
};
const alert = () => document.querySelector('.screenbot-stage [role="alert"]');

try {
  await until(() => document.querySelector(".screenbot-stage"), "ScreenBot never rendered");
  await compose(shot("shot-a", "scope-a", "Account A"), "Account A private words");
  await startSend();
  // Sign-out, then a different account takes a shot while A's send is still out.
  emit(listeners.reset, undefined);
  emit(listeners.roster, roster(null));
  await compose(shot("shot-b", "scope-b", "Account B"), "Account B words");
  pending.shift()!({ ok: false, error: "Old account failed" });
  await pause(800);
  if (input().value !== "Account B words") throw new Error("A late old-account failure replaced the new account's words: " + input().value);
  if (alert()) throw new Error("A late old-account failure showed its error to the new account");
  // The same failure after a same-account retake does bring the words back, with the reason.
  await startSend();
  await compose(shot("shot-b-retake", "scope-b", "Account B"));
  pending.shift()!({ ok: false, error: "Same account retry" });
  await until(() => alert()?.textContent?.includes("Same account retry"), "A same-account failure lost its error");
  if (input().value !== "Account B words") throw new Error("A same-account retake did not restore the failed send's words: " + input().value);
  console.log("FIXTURE_RESULT " + JSON.stringify({ reports: ["late old-account send failure stays out of the new account; same-account retake restores words"] }));
} catch (error) {
  console.log("FIXTURE_RESULT " + JSON.stringify({ error: String(error) }));
}
