import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { countdownKey, renderSetupCountdown, waitForAutomaticSetup } from "../src/setup-countdown";
import { terminalTextWidth } from "../src/terminal";

test("countdown fits narrow terminals with and without color", () => {
  for (const width of [24, 40, 80])
    for (const color of [false, true]) {
      for (const seconds of [5, 4, 3, 2, 1]) {
        const line = renderSetupCountdown(seconds, { width, color });
        expect(terminalTextWidth(line)).toBeLessThanOrEqual(width);
        expect(stripVTControlCharacters(line)).toContain(`Starting in ${seconds}s`);
      }
    }
});

test("Enter starts now; Esc, q, Ctrl-C, and Ctrl-D cancel; other input is ignored", () => {
  for (const chunk of ["\r", "\n", "\r\n", "\r\r"]) expect(countdownKey(chunk)).toBe("start");
  for (const chunk of ["\x1b", "\x1b\x1b", "q", "Q", "\x03", "\x04", "x\x03"])
    expect(countdownKey(chunk)).toBe("cancel");
  for (const chunk of ["x", " ", "\x1b[A", "\x1bOB", "multi\nline", "qq"])
    expect(countdownKey(chunk)).toBeNull();
});

test("redirected input never silently approves automatic setup", async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    expect(await waitForAutomaticSetup()).toBe(false);
});

const python = Bun.which("python3");
describe.skipIf(!python || process.platform === "win32")("real terminal countdown", () => {
  test.each([
    "escape",
    "q",
    "enter",
    "letter",
    "ctrl-c",
    "arrow",
    "paste",
    "continue",
    "resize",
    "dumb",
  ])("%s restores terminal state and completes once", async (scenario) => {
    const resultPath = join(tmpdir(), `openteam-countdown-${crypto.randomUUID()}.json`);
    const child = Bun.spawn(
      [
        python!,
        resolve(import.meta.dir, "fixtures/countdown-pty.py"),
        "40",
        scenario,
        process.execPath,
        resolve(import.meta.dir, "fixtures/setup-countdown.ts"),
      ],
      {
        env: {
          ...process.env,
          TERM: scenario === "dumb" ? "dumb" : "xterm-256color",
          NO_COLOR: "1",
          COUNTDOWN_RESULT_PATH: resultPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(error).toBe("");
    // Read the machine result independently of PTY rendering, as ConPTY does.
    // The assertions below still cover terminal output and restoration.
    const result = await Bun.file(resultPath)
      .json()
      .finally(() => rm(resultPath, { force: true }));
    const cleaned = stripVTControlCharacters(output);
    const results = cleaned
      .split(/[\r\n]+/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    expect(result.rawRestored).toBe(true);
    expect(result.listenersRestored).toBe(true);
    expect(results.find((row) => "terminalRestored" in row).terminalRestored).toBe(true);
    const proceed = !["escape", "q", "ctrl-c"].includes(scenario);
    const immediate = !proceed || scenario === "enter";
    expect(result.proceed).toBe(proceed);
    expect(output.includes("Starting setup…")).toBe(proceed);
    expect(cleaned.replace(/\s+/g, " ")).toContain("Press Enter to start now, or Esc to cancel.");
    if (immediate) expect(result.elapsed).toBeLessThan(2000);
    else {
      // Stray keys, arrows, and pastes neither cancel nor skip the countdown.
      expect(result.elapsed).toBeGreaterThanOrEqual(4900);
      expect(result.elapsed).toBeLessThan(7000);
      for (const seconds of [5, 4, 3, 2, 1]) expect(output).toContain(`Starting in ${seconds}s`);
    }
    if (scenario === "dumb") expect(output).not.toContain("\x1b[");
    else expect(output).toContain("\x1b[?25h");
  }, 12_000);
});
