import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { renderSetupCountdown, waitForAutomaticSetup } from "../src/setup-countdown";
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

test("redirected input never silently approves automatic setup", async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    expect(await waitForAutomaticSetup()).toBe(false);
});

const python = Bun.which("python3");
describe.skipIf(!python || process.platform === "win32")("real terminal countdown", () => {
  test.each([
    "escape",
    "enter",
    "letter",
    "ctrl-c",
    "arrow",
    "paste",
    "continue",
    "resize",
    "dumb",
  ])("%s restores terminal state and completes once", async (scenario) => {
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
    const cleaned = stripVTControlCharacters(output);
    const results = cleaned
      .split(/[\r\n]+/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const result = results.find((row) => "proceed" in row);
    expect(result).toBeDefined();
    expect(result.rawRestored).toBe(true);
    expect(result.listenersRestored).toBe(true);
    expect(results.find((row) => "terminalRestored" in row).terminalRestored).toBe(true);
    const proceed = ["continue", "resize", "dumb"].includes(scenario);
    expect(result.proceed).toBe(proceed);
    expect(output.includes("Starting setup…")).toBe(proceed);
    if (proceed) {
      expect(result.elapsed).toBeGreaterThanOrEqual(4900);
      expect(result.elapsed).toBeLessThan(7000);
      for (const seconds of [5, 4, 3, 2, 1]) expect(output).toContain(`Starting in ${seconds}s`);
    } else expect(result.elapsed).toBeLessThan(2000);
    if (scenario === "dumb") expect(output).not.toContain("\x1b[");
    else expect(output).toContain("\x1b[?25h");
  }, 12_000);
});
