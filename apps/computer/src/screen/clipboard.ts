import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { ScreenClipboardInput, ScreenClipboardView } from "@openteam/contracts";
import { spawnAgentProcess as spawn, agentProcessIdentity } from "../agent-process";
import { run } from "./processes";

const MAX_CLIPBOARD_BYTES = 4_000_000;
const read = (target: string, env: NodeJS.ProcessEnv, signal: AbortSignal) =>
  run("xclip", ["-selection", "clipboard", "-out", "-target", target], {
    env, captureStdout: true, signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
  });

/** Install a fresh X11 selection owner; Chromium caches text from an unchanged owner. */
export async function performClipboardOperation(
  input: ScreenClipboardInput,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  retainOwner: (child: ChildProcess) => void
): Promise<ScreenClipboardView> {
  signal.throwIfAborted();
  if (input.action === "paste") {
    if (!input.text) return {};
    const text = Buffer.from(input.text.replace(/\r\n?/g, "\n"), "utf8");
    if (text.length > MAX_CLIPBOARD_BYTES) throw new Error("Clipboard text is too large");
    const owner = spawn("xclip", ["-selection", "clipboard", "-in", "-target", "UTF8_STRING", "-quiet"], {
      env, ...agentProcessIdentity(), stdio: ["pipe", "ignore", "ignore"],
    });
    let error: Error | undefined;
    owner.once("error", value => { error = value; });
    owner.stdin.on("error", value => { error = value; });
    owner.stdin.end(text);
    let retained = false;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay(25, undefined, { signal });
        if (error) throw error;
        if (owner.exitCode !== null) throw new Error("Clipboard owner exited before paste");
        const actual = await read("UTF8_STRING", env, signal).catch(() => undefined);
        if (actual?.equals(text)) { ready = true; break; }
      }
      if (!ready) throw new Error("Clipboard was not ready; no paste was sent");
      signal.throwIfAborted();
      await run("xdotool", ["key", "--clearmodifiers", input.shift ? "ctrl+shift+v" : "ctrl+v"], { env, signal, failOnStderr: true });
      // Keep the owner alive after the HTTP reply so apps can consume the selection.
      retainOwner(owner);
      retained = true;
      return {};
    } finally {
      if (!retained) owner.kill();
    }
  }

  const previous = await read("TIMESTAMP", env, signal).catch(() => undefined);
  const key = input.action === "cut" ? "x" : "c";
  await run("xdotool", ["key", "--clearmodifiers", `ctrl+${input.shift ? "shift+" : ""}${key}`], { env, signal, failOnStderr: true });
  // Wait for the app's selection update rather than returning the old text on copy.
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(25, undefined, { signal });
    const timestamp = await read("TIMESTAMP", env, signal).catch(() => undefined);
    if (timestamp && (!previous || !timestamp.equals(previous))) break;
    if (!timestamp && attempt >= 3) break;
  }
  signal.throwIfAborted();
  const text = await read("UTF8_STRING", env, signal);
  if (text.length > MAX_CLIPBOARD_BYTES) throw new Error("Clipboard text is too large");
  return { text: text.toString("utf8") };
}
