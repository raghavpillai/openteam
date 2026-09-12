import { run } from "./processes";

export async function typeText(
  text: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  const type = (value: string) =>
    run("xdotool", ["type", "--clearmodifiers", "--delay", "2", "--", value], {
      env: { ...env, LC_ALL: "C.UTF-8" },
      failOnStderr: true,
      signal,
    });
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
