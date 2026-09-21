import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { typeText } from "../src/screen/typing";
import { run } from "../src/screen/processes";

// Integration test in a disposable computer image: private X server and files,
// no connection to a live bot desktop, browser profile or user's display.
if (process.platform !== "linux") throw new Error("Run this test inside the computer image");
const root = await mkdtemp(join(tmpdir(), "native-typing-"));
const file = join(root, "native-typing.txt");
await writeFile(file, "");
let editor: ChildProcess | undefined;
const xvfb = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  const display = await new Promise<string>((resolve, reject) => {
    xvfb.once("error", reject);
    xvfb.once("exit", (code) => reject(new Error(`Xvfb exited ${code}`)));
    xvfb.stdout!.once("data", (chunk) => resolve(String(chunk).trim()));
  });
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    DISPLAY: `:${display}`,
    LANG: "C",
    LC_ALL: "C",
  };
  editor = spawn("mousepad", ["--disable-server", file], {
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  await run(
    "xdotool",
    ["search", "--sync", "--onlyvisible", "--class", "Mousepad", "windowfocus"],
    { env, signal: AbortSignal.timeout(10000) }
  );
  for (const text of [
    "CUA-NATIVE-0921\nCafé 42",
    "first\n\nthird\n",
    "CRLF\r\nsecond\rthird",
    "日本語 Ω 🙂\nsecond line",
  ]) {
    await run("xdotool", ["key", "--clearmodifiers", "ctrl+a"], { env });
    await typeText(text, env);
    await run("xdotool", ["key", "--clearmodifiers", "ctrl+s"], { env });
    const expected = text.replace(/\r\n?/g, "\n");
    let actual = "";
    for (let i = 0; i < 30; i++) {
      actual = await readFile(file, "utf8");
      if (actual === expected) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(actual, expected);
  }
  console.log(
    "PASS native GTK editor: Unicode, line breaks, blank/trailing lines, CRLF and save persistence"
  );
} finally {
  editor?.kill();
  xvfb.kill();
  await rm(root, { recursive: true, force: true });
}
