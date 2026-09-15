import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { statusFixture, statusScenarios } from "./fixtures/status-scenarios";
import { terminalTextWidth } from "../src/terminal";
import { stripVTControlCharacters } from "node:util";
import { writeUpdateState } from "../src/update-safety";

const stub = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { StatusScenarioRunner } from ${JSON.stringify(resolve(import.meta.dir, "fixtures/status-scenarios.ts"))};
const args = process.argv.slice(2);
const command = process.argv[1].endsWith('docker-compose') ? 'docker-compose' : 'docker';
appendFileSync(process.env.OPENTEAM_TEST_CALLS, JSON.stringify({command,args}) + '\\n');
const result = new StatusScenarioRunner(process.env.OPENTEAM_TEST_SCENARIO).run(command,args);
process.stdout.write(result.stdout); process.stderr.write(result.stderr || result.error?.message || '');
process.exit(result.status);
`;

const installStub = (f: ReturnType<typeof statusFixture>, id: string) => {
  const bin = join(f.directory, "bin");
  mkdirSync(bin);
  if (id !== "docker-missing")
    for (const name of ["docker", "docker-compose"]) {
      const file = join(bin, name);
      writeFileSync(file, stub);
      chmodSync(file, 0o755);
    }
  return {
    ...process.env,
    PATH: bin,
    NO_COLOR: "1",
    TERM: "dumb",
    OPENTEAM_TEST_SCENARIO: id,
    OPENTEAM_TEST_CALLS: join(f.directory, "calls.jsonl"),
  };
};

describe.skipIf(process.platform === "win32")("actual status and health CLI commands", () => {
  test("both aliases preserve active-update JSON output without probing Docker", async () => {
    const f = statusFixture("healthy");
    try {
      const env = installStub(f, "healthy");
      writeUpdateState(f.paths, {
        schemaVersion: 1,
        fromVersion: "1.2.3",
        startedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        jobId: "status-test",
        status: "running",
        phase: "pulling",
        message: "Downloading server images",
        targetVersion: "1.2.4",
      });
      const outputs: string[] = [];
      for (const command of ["status", "health"]) {
        const child = Bun.spawn(
          [
            process.execPath,
            resolve(import.meta.dir, "../src/main.ts"),
            command,
            "--dir",
            f.paths.directory,
            "--json-progress",
          ],
          { env, stdout: "pipe", stderr: "pipe" }
        );
        const [output, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe("");
        expect(output.startsWith("@@OPENTEAM_UPDATE@@")).toBe(true);
        expect(JSON.parse(output.slice("@@OPENTEAM_UPDATE@@".length))).toMatchObject({
          phase: "pulling",
          version: "1.2.4",
        });
        outputs.push(output);
      }
      expect(outputs[0]).toBe(outputs[1]);
      expect(existsSync(env.OPENTEAM_TEST_CALLS)).toBe(false);
      expect(f.requests).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
  test.each(statusScenarios)(
    "%s: both aliases have the same output and exit status",
    async (id, _title, state, expected) => {
      const f = statusFixture(id);
      try {
        const env = installStub(f, id);
        const outputs: string[] = [];
        for (const command of ["status", "health"]) {
          const child = Bun.spawn(
            [
              process.execPath,
              resolve(import.meta.dir, "../src/main.ts"),
              command,
              "--dir",
              f.paths.directory,
            ],
            { env, stdout: "pipe", stderr: "pipe" }
          );
          const [output, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(code).toBe(state === "RUNNING" ? 0 : 2);
          expect(stderr).toBe("");
          expect(output).toContain(state);
          expect(output.replace(/\s+/g, " ")).toContain(expected);
          outputs.push(output);
        }
        expect(outputs[0]).toBe(outputs[1]);
        for (const [file, content] of f.before) expect(readFileSync(file, "utf8")).toBe(content);
        expect(f.requests.every((path) => path === "/api/v0/health")).toBe(true);
        if (existsSync(env.OPENTEAM_TEST_CALLS)) {
          const calls = readFileSync(env.OPENTEAM_TEST_CALLS, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(
            calls.every(
              (call) =>
                !call.args.some((arg: string) =>
                  ["up", "start", "stop", "restart", "exec", "pull", "down"].includes(arg)
                )
            )
          ).toBe(true);
          for (const call of calls.filter((call) => call.args.includes("json"))) {
            expect(call.args).toContain("friend-team");
            expect(call.args).toContain(f.paths.directory);
          }
        }
      } finally {
        f.cleanup();
      }
    },
    15_000
  );

  const python = Bun.which("python3");
  test.skipIf(!python).each([
    [24, "xterm-256color", false],
    [40, "xterm-256color", true],
    [80, "dumb", false],
  ] as const)("health in a PTY: %s columns, TERM=%s, NO_COLOR=%s", async (width, term, noColor) => {
    const f = statusFixture("unhealthy");
    try {
      const env: NodeJS.ProcessEnv = { ...installStub(f, "unhealthy"), TERM: term };
      if (!noColor) delete env.NO_COLOR;
      const child = Bun.spawn(
        [
          python!,
          resolve(import.meta.dir, "fixtures/capture-pty.py"),
          String(width),
          process.execPath,
          resolve(import.meta.dir, "../src/main.ts"),
          "health",
          "--dir",
          f.paths.directory,
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
      expect(output).toContain("NEEDS ATTENTION");
      if (noColor || term === "dumb") expect(output).not.toContain("\x1b");
      else expect(output).toContain("\x1b[31m");
      expect(
        stripVTControlCharacters(output)
          .replaceAll("\r", "")
          .split("\n")
          .every((line) => terminalTextWidth(line) <= width)
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });
});
