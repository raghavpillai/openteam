import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
const python = Bun.which("python3");
type Step = { send?: string; expect?: string; resize?: number[] };
const drive = async (columns: number, mode: string, steps: Step[]) => {
  const child = Bun.spawn(
    [
      python!,
      resolve(import.meta.dir, "fixtures/interactive-pty.py"),
      JSON.stringify({ columns, steps }),
      Bun.which("bun")!,
      resolve(import.meta.dir, "fixtures/provider-connection-pty.ts"),
      mode,
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
  expect(output).not.toContain("synthetic-state");
  return stripVTControlCharacters(output);
};
describe.skipIf(!python || process.platform === "win32")(
  "provider login in a real terminal",
  () => {
    test.each([
      40, 90,
    ])("can start browser login, back out of pasted input, and cancel at %i columns", async (width) => {
      const output = await drive(width, "browser", [
        { expect: "CONNECT CLAUDE" },
        { send: "\x1b[B\r", expect: "Open sign-in page" },
        { send: "\x1b[B\x1b[B\r", expect: "Waiting for input" },
        { send: "synthetic-private-redirect-code", expect: "••••" },
        { send: "\x1b", expect: "Open sign-in page" },
        { send: "\x1b", expect: "BACK TO PROVIDERS" },
      ]);
      expect(output).not.toContain("synthetic-private-redirect-code");
      expect(output).toContain("REMOTE CANCELLATIONS: 1");
      expect(output).toContain("SUBMITTED VALUES: 0");
    }, 15000);
    test("Ctrl+C during a pending start returns to providers and cancels remotely", async () => {
      const output = await drive(90, "slow", [
        { expect: "CONNECT CLAUDE" },
        { send: "\x1b[B\r", expect: "Starting sign-in" },
        { send: "\x03", expect: "BACK TO PROVIDERS" },
      ]);
      expect(output).toContain("REMOTE CANCELLATIONS: 1");
    }, 15000);
    test("a hidden API key survives resizing and can be cancelled without submission", async () => {
      const output = await drive(90, "key", [
        { expect: "Waiting for input" },
        { send: "synthetic-private-api-key", expect: "••••" },
        { resize: [24, 40], expect: "••••" },
        { send: "\x03", expect: "BACK TO PROVIDERS" },
      ]);
      expect(output).not.toContain("synthetic-private-api-key");
      expect(output).toContain("SUBMITTED VALUES: 0");
    }, 15000);
    test("a missing imported login offers a way back", async () => {
      const output = await drive(40, "missing", [
        { expect: "Use Claude Code login" },
        { send: "\r", expect: "No reusable Claude Code login" },
        { send: "\x1b", expect: "BACK TO PROVIDERS" },
      ]);
      expect(output).toContain("REMOTE CANCELLATIONS: 0");
    }, 15000);
  }
);
