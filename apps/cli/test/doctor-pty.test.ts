import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { terminalTextWidth } from "../src/terminal";

const python = Bun.which("python3");
describe.skipIf(process.platform === "win32" || !python)(
  "doctor in an actual pseudo-terminal",
  () => {
    test.each([
      { columns: 24, term: "xterm-256color", noColor: false },
      { columns: 40, term: "xterm-256color", noColor: true },
      { columns: 80, term: "dumb", noColor: false },
    ])("$columns columns, TERM=$term, NO_COLOR=$noColor", async ({ columns, term, noColor }) => {
      const directory = mkdtempSync(join(tmpdir(), "openteam-doctor-pty-"));
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: directory, TERM: term };
        if (noColor) env.NO_COLOR = "1";
        else delete env.NO_COLOR;
        const child = Bun.spawn(
          [
            python!,
            resolve(import.meta.dir, "fixtures/capture-pty.py"),
            String(columns),
            process.execPath,
            resolve(import.meta.dir, "../src/main.ts"),
            "doctor",
            "--dir",
            join(directory, "installation"),
          ],
          { env, stdout: "pipe", stderr: "pipe" }
        );
        const [output, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(2);
        expect(stderr).toBe("");
        if (term === "dumb") expect(output).not.toContain("\x1b");
        else expect(output).toContain("\x1b[2K"); // The progress line is cleared before the report.
        if (noColor || term === "dumb") expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
        else expect(output).toContain("\x1b[31m");
        // Ignore transient progress updates; inspect the complete report as the terminal sees it.
        const plain = stripVTControlCharacters(output).replace(/\r/g, "");
        const report = plain.slice(plain.indexOf("  ╭"));
        expect(report).toContain("NEEDS ATTENTION");
        expect(report).toContain("NEXT STEPS");
        expect(report.split("\n").every((line) => terminalTextWidth(line) <= columns)).toBe(true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
);
