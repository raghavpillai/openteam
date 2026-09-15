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
    test.each([40, 90])("edits and saves both tabs at %i columns", async (columns) => {
      const f = modelServer();
      try {
        const { output, plain, code } = await drive(
          f.paths.directory,
          columns,
          [
            { expect: "Inference]" },
            { send: keys.enter, expect: "CHOOSE A PROVIDER" },
            { send: keys.enter, expect: "CHOOSE AN INFERENCE MODEL" },
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
          columns === 90
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
    test("24-column terminal can close cleanly without changes", async () => {
      const f = modelServer();
      try {
        const { code } = await drive(f.paths.directory, 24, [
          { expect: "OPENTEAM / model" },
          { send: keys.end + keys.enter, expect: "SAVED SETTINGS" },
        ]);
        expect(code).toBe(0);
        expect(f.calls.inference).toHaveLength(0);
        expect(f.calls.transcription).toHaveLength(0);
      } finally {
        f.cleanup();
      }
    }, 15000);
    test("noninteractive use explains the scriptable alternatives", async () => {
      const child = Bun.spawn(
        [process.execPath, resolve(import.meta.dir, "../src/main.ts"), "model"],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain("needs an interactive terminal");
      expect(stdout + stderr).toContain("model list");
    });
  }
);

describe.skipIf(process.platform === "win32" || !python)("shared setup terminal driver", () => {
  test("setup still accepts navigation and cancellation and restores terminal state", async () => {
    const child = Bun.spawn(
      [
        python!,
        resolve(import.meta.dir, "fixtures/interactive-pty.py"),
        JSON.stringify({
          columns: 90,
          steps: [
            { expect: "OPENTEAM" },
            { send: keys.right, expect: "Create the username and password" },
            { send: keys.esc, expect: "Setup cancelled without changes." },
          ],
        }),
        process.execPath,
        resolve(import.meta.dir, "fixtures/setup-pty.ts"),
      ],
      {
        env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (error) console.error(error, stripVTControlCharacters(output).slice(-2000));
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(output).toContain("\x1b[?25h");
  }, 15000);
});

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
