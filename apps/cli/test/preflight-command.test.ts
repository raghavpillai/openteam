import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createEnvironment, installationPaths, writeManifest } from "../src/config";
import { terminalTextWidth } from "../src/terminal";

// All non-diagnostic commands fail closed: these tests must never pull images,
// inspect credentials, read running services, or mutate a Docker installation.
const docker = `#!/bin/sh
printf '%s\\n' "$*" >> "$OPENTEAM_TEST_CALLS"
case "$*" in
  --version) printf 'Docker version 29.0.0\\n' ;;
  'info --format {{.ServerVersion}}')
    if [ "$OPENTEAM_TEST_CASE" = stopped ]; then
      printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\\n' >&2; exit 1
    fi
    printf '29.0.0\\n' ;;
  'compose version')
    if [ "$OPENTEAM_TEST_CASE" = compose-missing ]; then exit 1; fi
    if [ "$OPENTEAM_TEST_CASE" = compose-old ]; then printf 'Docker Compose version v1.29.2\\n'; else printf 'Docker Compose version v5.1.3\\n'; fi ;;
  *) printf 'Unexpected Docker command\\n' >&2; exit 99 ;;
esac
`;

describe.skipIf(process.platform === "win32")("install and setup preflight", () => {
  for (const command of ["install", "setup"] as const) {
    for (const installed of [false, true]) {
      test.each([
        ["missing", "The docker command was not found"],
        ["stopped", "could not connect to its engine"],
        ["compose-missing", "Neither the Docker Compose plugin"],
        ["compose-old", "2.20.0"],
      ])(`${command}, ${installed ? "resumed" : "fresh"}, %s stops before changes`, async (scenario, message) => {
        const directory = mkdtempSync(join(tmpdir(), "openteam-preflight-"));
        try {
          const bin = join(directory, "bin");
          mkdirSync(bin);
          if (scenario !== "missing") writeFileSync(join(bin, "docker"), docker, { mode: 0o755 });
          const paths = installationPaths(join(directory, "server installation"));
          const before = new Map<string, string>();
          if (installed) {
            mkdirSync(paths.directory);
            writeFileSync(paths.compose, "services: {}\n");
            writeFileSync(paths.environment, createEnvironment({ version: "0.0.1" }), {
              mode: 0o600,
            });
            writeManifest(paths, {
              schemaVersion: 1,
              version: "0.0.1",
              repository: "example/test",
              composeUrl: "https://example.test/compose.yaml",
              installedAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            });
            for (const file of [paths.compose, paths.environment, paths.manifest])
              before.set(file, readFileSync(file, "utf8"));
          }
          const calls = join(directory, "calls");
          const child = Bun.spawn(
            [
              process.execPath,
              resolve(import.meta.dir, "../src/main.ts"),
              command,
              "--dir",
              paths.directory,
            ],
            {
              env: {
                ...process.env,
                PATH: bin,
                NO_COLOR: "1",
                OPENTEAM_TEST_CASE: scenario,
                OPENTEAM_TEST_CALLS: calls,
              },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            }
          );
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          const output = `${stdout}\n${stderr}`.replace(/\s+/g, " ");
          expect(code).toBe(2);
          expect(output).toContain(message);
          expect(output).toContain("NEXT STEPS");
          expect(output).toContain("openteam setup --dir");
          expect(output).toContain("paused");
          expect(output).not.toContain("Unexpected Docker command");
          expect(output).not.toContain("requires a terminal");
          expect(output).not.toContain("Downloading");
          expect(output).not.toContain("Password");
          for (const [file, body] of before) expect(readFileSync(file, "utf8")).toBe(body);
          if (!installed) expect(existsSync(paths.directory)).toBe(false);
          if (existsSync(calls))
            expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
              "--version",
              "info --format {{.ServerVersion}}",
              "compose version",
            ]);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }

  test("fresh setup runs preflight and asks for a terminal before downloading", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-setup-first-run-"));
    try {
      const bin = join(directory, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "docker"), docker, { mode: 0o755 });
      const target = join(directory, "installation");
      const child = Bun.spawn(
        [process.execPath, resolve(import.meta.dir, "../src/main.ts"), "setup", "--dir", target],
        {
          env: {
            ...process.env,
            PATH: bin,
            NO_COLOR: "1",
            OPENTEAM_TEST_CALLS: join(directory, "calls"),
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(2);
      expect(`${stdout}\n${stderr}`).toContain("Preflight checks passed");
      expect(`${stdout}\n${stderr}`).toContain("interactive terminal");
      expect(`${stdout}\n${stderr}`).not.toContain("Downloading");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const python = Bun.which("python3");
describe.skipIf(process.platform === "win32" || !python)("preflight terminal output", () => {
  for (const command of ["install", "setup"]) {
    test.each([
      24, 40, 80,
    ])(`${command} explains missing Docker in a %s-column terminal`, async (columns) => {
      const directory = mkdtempSync(join(tmpdir(), "openteam-preflight-pty-"));
      try {
        const child = Bun.spawn(
          [
            python!,
            resolve(import.meta.dir, "fixtures/capture-pty.py"),
            String(columns),
            process.execPath,
            resolve(import.meta.dir, "../src/main.ts"),
            command,
            "--dir",
            join(directory, "installation"),
          ],
          {
            env: { ...process.env, PATH: directory, TERM: "xterm-256color", NO_COLOR: "1" },
            stdout: "pipe",
            stderr: "pipe",
          }
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(2);
        expect(stderr).toBe("");
        const output = stripVTControlCharacters(stdout).replace(/\r/g, "");
        expect(output).toContain("NEXT STEPS");
        expect(output.replace(/\s+/g, " ")).toContain("The CLI is available");
        expect(output.split("\n").every((line) => terminalTextWidth(line) <= columns)).toBe(true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
