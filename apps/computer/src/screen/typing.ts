import { run } from "./processes";
import { spawn } from "node:child_process";
import { agentProcessIdentity } from "../agent-process";

async function pasteSupplementaryUnicode(text: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  // X11 keysyms above the BMP are silently dropped by LibreOffice. Clipboard
  // UTF-8 reaches its native input path without changing the document directly.
  // This is the assigned bot desktop's clipboard, never the host clipboard.
  const readClipboard = (cleanup = false) => run("xclip", ["-selection", "clipboard", "-out", "-target", "UTF8_STRING"], {
    env, captureStdout: true, signal: signal && !cleanup ? AbortSignal.any([signal, AbortSignal.timeout(1_000)]) : AbortSignal.timeout(1_000),
  });
  const previous = await readClipboard().catch(() => undefined);
  signal?.throwIfAborted();
  const owner = (value: Buffer, detached = false) => {
    const child = spawn("xclip", ["-selection", "clipboard", "-in", "-target", "UTF8_STRING", "-quiet"], {
      env, ...agentProcessIdentity(), detached, stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.on("error", () => {});
    child.stdin.end(value);
    return child;
  };
  const value = Buffer.from(text.replace(/\r\n?/g, "\n"));
  const clipboard = owner(value);
  let error: Error | undefined;
  clipboard.once("error", e => { error = e; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      signal?.throwIfAborted();
      if (error) throw error;
      if (clipboard.exitCode !== null) throw new Error("Unicode clipboard helper exited before typing");
      await new Promise(resolve => setTimeout(resolve, 25));
      if ((await readClipboard().catch(() => undefined))?.equals(value)) { ready = true; break; }
    }
    if (!ready) throw new Error("Unicode clipboard was not ready; no paste was sent");
    await run("xdotool", ["key", "--clearmodifiers", "ctrl+v"], { env, failOnStderr: true, signal });
    // Let the native application consume the selection before restoring it.
    await new Promise(resolve => setTimeout(resolve, 300));
  } finally {
    // Do not overwrite a clipboard changed by another actor during the paste.
    if (previous && (await readClipboard(true).catch(() => undefined))?.equals(value)) {
      const restored = owner(previous, true);
      restored.on("error", () => {});
      restored.unref(); // X11 retains a selection only while its owner lives.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    clipboard.kill();
  }
}

export async function typeText(
  text: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  if (/[^\u0000-\uFFFF]/u.test(text)) {
    await pasteSupplementaryUnicode(text, env, signal);
    return;
  }
  const type = async (value: string) => {
    // xdotool maps literal newlines to Linefeed, which GTK editors ignore.
    // Use the same Return key as normal keyboard input, retaining blank lines.
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (index > 0) await run("xdotool", ["key", "--clearmodifiers", "Return"], { env, failOnStderr: true, signal });
      if (lines[index]) await run("xdotool", ["type", "--clearmodifiers", "--delay", "2", "--", lines[index]!], {
        env: { ...env, LC_ALL: "C.UTF-8" },
        failOnStderr: true,
        signal,
      });
    }
  };
  if (!/[^\p{ASCII}]/u.test(text)) {
    await type(text);
    return;
  }

  // xdotool reuses and immediately clears a scratch keycode for unmapped
  // characters. Chromium can read the cleared mapping before consuming the
  // key event. Keep a mapping for every character throughout each batch.
  const mapping = (await run("xmodmap", ["-pke"], { env, captureStdout: true, signal })).toString();
  const keycodes = [...mapping.matchAll(/^keycode\s+(\d+)\s*=\s*$/gm)].map((match) =>
    Number(match[1])
  );
  if (!keycodes.length) throw new Error("No unused X11 keycodes available for Unicode typing");

  const sendBatch = async (value: string, characters: Set<string>) => {
    const codes = keycodes.slice(0, characters.size);
    const bindings = [...characters].flatMap((character, index) => {
      const symbol = `U${character.codePointAt(0)?.toString(16).padStart(4, "0")}`;
      return ["-e", `keycode ${codes[index]} = ${symbol} ${symbol}`];
    });
    try {
      await run("xmodmap", bindings, { env, failOnStderr: true, signal });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await type(value);
    } finally {
      // Leave the mappings in place while desktop clients consume queued input.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await run(
        "xmodmap",
        codes.flatMap((code) => ["-e", `keycode ${code} =`]),
        {
          env,
          failOnStderr: true,
        }
      );
    }
  };

  let batch = "";
  let characters = new Set<string>();
  for (const character of text) {
    if (character.charCodeAt(0) > 0x7f) {
      if (!characters.has(character) && characters.size === keycodes.length) {
        await sendBatch(batch, characters);
        batch = "";
        characters = new Set();
      }
      characters.add(character);
    }
    batch += character;
  }
  if (batch) await sendBatch(batch, characters);
}
