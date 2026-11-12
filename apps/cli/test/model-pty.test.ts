import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { modelServer } from "./fixtures/model-server";
const python = Bun.which("python3");
const keys = {
  down: "\x1b[B",
  right: "\x1b[C",
  enter: "\r",
  end: "\x1b[F",
  ctrlu: "\x15",
  ctrlc: "\x03",
  esc: "\x1b",
};
type Step = { send?: string; expect?: string; resize?: number[] };
async function drive(directory: string, columns: number, steps: Step[], color = false) {
  const env = { ...process.env, TERM: "xterm-256color", ...(color ? {} : { NO_COLOR: "1" }) };
  if (color) delete env.NO_COLOR;
  const child = Bun.spawn(
    [
      python!,
      resolve(import.meta.dir, "fixtures/interactive-pty.py"),
      JSON.stringify({ columns, steps }),
      process.execPath,
      resolve(import.meta.dir, "../src/main.ts"),
      "model",
      "--dir",
      directory,
    ],
    { env, stdout: "pipe", stderr: "pipe" }
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (error) console.error(error, stripVTControlCharacters(output).slice(-3000));
  expect(error).toBe("");
  return { output, plain: stripVTControlCharacters(output), code };
}
describe.skipIf(process.platform === "win32" || !python)(
  "interactive model in a real terminal",
  () => {
    test("edits and saves both tabs", async () => {
      const columns = 90;
      const f = modelServer();
      try {
        const { output, plain, code } = await drive(
          f.paths.directory,
          columns,
          [
            { expect: "Inference]" },
            { send: keys.enter, expect: "CHOOSE A PROVIDER" },
            { send: keys.enter, expect: "128k context" },
            { send: "fast\r\r", expect: "Currently saved" },
            { send: keys.down.repeat(3) + keys.enter, expect: "Inference saved." },
            { send: keys.right, expect: "Transcription]" },
            {
              send: keys.down.repeat(3) + keys.enter + keys.ctrlu + "speech-large\r",
              expect: "speech-large",
            },
            { send: keys.down.repeat(4) + keys.enter, expect: "Transcription saved." },
            { send: keys.end + keys.enter, expect: "SAVED SETTINGS" },
          ],
          true
        );
        expect(code).toBe(0);
        expect(f.calls.inference[0]?.modelId).toBe("fast");
        expect(f.calls.transcription[0]?.model).toBe("speech-large");
        expect(output).toContain("\x1b[?25h");
        expect(plain).not.toContain("unexpected-response-secret");
      } finally {
        f.cleanup();
      }
    }, 15000);
    test("masks pasted key input and restores terminal state on Ctrl+C after a resize", async () => {
      const f = modelServer();
      try {
        const secret = "synthetic-private-pty-credential";
        const { output, plain, code } = await drive(f.paths.directory, 90, [
          { expect: "Inference]" },
          { send: keys.right, expect: "Transcription]" },
          { send: keys.down.repeat(5) + keys.enter + secret, expect: "••••" },
          { resize: [24, 40], expect: "••••" },
          { send: keys.ctrlc, expect: "cancelled" },
        ]);
        expect(code).not.toBe(0);
        expect(output).toContain("\x1b[?25h");
        expect(plain).not.toContain(secret);
        expect(f.calls.transcription).toHaveLength(0);
      } finally {
        f.cleanup();
      }
    }, 15000);
  }
);

describe.skipIf(process.platform === "win32" || !python)("interrupted model requests", () => {
  test("Ctrl+C exits a pending save and explains that its server outcome may be uncertain", async () => {
    const f = modelServer();
    f.api.saveInference = async () => new Promise(() => {});
    try {
      const { plain, code, output } = await drive(f.paths.directory, 90, [
        { expect: "Inference]" },
        {
          send: keys.down.repeat(2) + keys.enter + keys.down + keys.enter,
          expect: "Saving settings",
        },
        { send: keys.ctrlc, expect: "Interrupted during a request" },
      ]);
      expect(code).not.toBe(0);
      expect(plain).toContain("A save may have completed");
      expect(output).toContain("\x1b[?25h");
    } finally {
      f.cleanup();
    }
  }, 15000);
});
