import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { modelServer } from "./fixtures/model-server";

// The one real-terminal smoke test: a pasted credential is never echoed, even
// after a resize redraw, and Ctrl+C restores the terminal without saving.
const python = Bun.which("python3");
test.skipIf(process.platform === "win32" || !python)(
  "masks pasted key input and restores terminal state on Ctrl+C after a resize",
  async () => {
    const f = modelServer();
    try {
      const secret = "synthetic-private-pty-credential";
      const steps = [
        { expect: "Inference]" },
        { send: "\x1b[C", expect: "Transcription]" },
        { send: "\x1b[B".repeat(5) + "\r" + secret, expect: "••••" },
        { resize: [24, 40], expect: "••••" },
        { send: "\x03", expect: "cancelled" },
      ];
      const child = Bun.spawn(
        [
          python!,
          resolve(import.meta.dir, "fixtures/interactive-pty.py"),
          JSON.stringify({ columns: 90, steps }),
          process.execPath,
          resolve(import.meta.dir, "../src/main.ts"),
          "model",
          "--dir",
          f.paths.directory,
        ],
        { env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" }
      );
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (error) console.error(error, stripVTControlCharacters(output).slice(-3000));
      expect(error).toBe("");
      expect(code).not.toBe(0);
      expect(output).toContain("\x1b[?25h");
      expect(stripVTControlCharacters(output)).not.toContain(secret);
      expect(f.calls.transcription).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  },
  15000
);
