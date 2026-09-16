import { waitForAutomaticSetup } from "../../src/setup-countdown";

const initial = Boolean(process.stdin.isRaw);
const listeners = process.stdin.listenerCount("data");
const started = performance.now();
const proceed = await waitForAutomaticSetup();
const result = JSON.stringify({
  proceed,
  elapsed: performance.now() - started,
  rawRestored: Boolean(process.stdin.isRaw) === initial,
  listenersRestored: process.stdin.listenerCount("data") === listeners,
});
// ConPTY may split JSON across cursor movements; keep a machine-readable result too.
if (process.env.COUNTDOWN_RESULT_PATH) await Bun.write(process.env.COUNTDOWN_RESULT_PATH, result);
console.log(result);
