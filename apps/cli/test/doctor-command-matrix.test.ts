import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createEnvironment,
  installationPaths,
  replaceEnvironmentValue,
  writeManifest,
} from "../src/config";

// One case per failure layer: Docker CLI, engine, Compose, configuration,
// services, health, model, and a passing run.
const cases: Array<[string, string, boolean?]> = [
  ["missing-cli", "Install Docker Desktop"],
  ["daemon-stopped", "Start your Docker runtime"],
  ["compose-fallback", "SETUP NEEDED"],
  ["env-permissions", "owner-only", true],
  ["migration-failed", "openteam logs migrate", true],
  ["health-version", "API port belongs to this installation", true],
  ["model-401", "Reconnect the provider in the OpenTeam app", true],
  ["healthy", "READY WITH NOTES", true],
];

// The stub only responds to diagnostic commands; unexpected commands fail closed.
// It runs in a separate process so PATH/permission errors exercise SystemCommandRunner.
const stub = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { SERVER_PROBE, WORKER_PROBE, STORAGE_PROBE } from ${JSON.stringify(resolve(import.meta.dir, "../src/doctor-probes.ts"))};
import { NOTIFICATION_STATE_PROBE, APNS_CONFIGURATION_PROBE } from ${JSON.stringify(resolve(import.meta.dir, "../src/doctor-notifications.ts"))};
const scenario = process.env.OPENTEAM_TEST_SCENARIO;
const args = process.argv.slice(2);
const standalone = process.argv[1].endsWith('docker-compose');
appendFileSync(process.env.OPENTEAM_TEST_CALLS, JSON.stringify({ standalone, args }) + '\\n');
const ok = stdout => { console.log(stdout); process.exit(0); };
const fail = stderr => { console.error(stderr); process.exit(1); };
if (args[0] === '--version') {
  ok('Docker version 28.2.2');
}
if (args[0] === 'info') {
  const failures = {
    'daemon-stopped': 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
  };
  if (failures[scenario]) fail(failures[scenario]);
  ok('28.2.2');
}
if ((args[0] === 'compose' && args[1] === 'version') || (standalone && args[0] === 'version')) {
  if (scenario === 'compose-fallback' && !standalone) fail('compose is not a docker command');
  ok('Docker Compose version v5.1.3');
}
if (args.includes('config') && args.includes('--quiet')) {
  ok('');
}
const services = ['postgres', 'server', 'worker', 'computer'];
if (args.includes('ps') && args.includes('--services')) ok(services.join('\\n'));
if (args.includes('ps') && args.includes('--quiet')) ok('a'.repeat(64));
if (args[0] === 'inspect') ok([...services, 'migrate'].map(service => JSON.stringify({
  service, state: service === 'migrate' ? 'exited' : 'running', health: 'healthy', restarts: 0,
  exitCode: service === 'migrate' && scenario === 'migration-failed' ? 1 : 0,
  startedAt: new Date().toISOString()
})).join('\\n'));
if (args.includes('exec')) {
  const script = args.at(-1);
  if (script.includes('Bun.stdin.text()')) {
    const errors = { 'model-401': 'HTTP 401: unauthorized' };
    ok(JSON.stringify(errors[scenario] ? {ok:false,error:errors[scenario]} : {ok:true}));
  }
  if (script.includes(NOTIFICATION_STATE_PROBE)) ok(JSON.stringify({ total: 0, eligible: 0, invalid: 0, topics: [], failed: 0, waiting: 0 }));
  if (script.includes(APNS_CONFIGURATION_PROBE)) ok(JSON.stringify({ missing: ['OPENTEAM_APNS_KEY_ID','OPENTEAM_APNS_TEAM_ID','OPENTEAM_APNS_PRIVATE_KEY'], issue: null, topic: 'dev.openteam.mobile.swift' }));
  const labels = script.includes(SERVER_PROBE) ? ['Database','Pending jobs','Run leases','Computer API']
    : script.includes(WORKER_PROBE) ? ['Worker heartbeat','Queue round trip']
    : script.includes(STORAGE_PROBE) ? args.includes('computer') ? ['workspace'] : ['agents','assets'] : [];
  if (!labels.length) fail('Unexpected diagnostic script');
  ok(JSON.stringify(labels.map(label => ({ label,
    level: 'pass', detail: 'Verified'
  }))));
}
fail('Unexpected Docker command: ' + args.join(' '));
`;

describe.skipIf(process.platform === "win32")("doctor command failure matrix", () => {
  test.each(cases)(
    "%s produces an understandable report without changing the installation",
    async (id, recommendation, installed = false) => {
      const directory = mkdtempSync(join(tmpdir(), "openteam-doctor-matrix-"));
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === "/api/v0/health") {
            return Response.json({
              status: "ready",
              runtime: { inference: "ready" },
              release: { releaseVersion: id === "health-version" ? "1.1.0" : "1.2.3" },
            });
          }
          if (request.url.endsWith("/transcription/check"))
            return Response.json({ level: "pass", detail: "Provider configured" });
          return Response.json({
            inference: { providerId: "example", modelId: "model", reasoning: "medium" },
          });
        },
      });
      try {
        const bin = join(directory, "bin");
        mkdirSync(bin);
        const calls = join(directory, "calls.jsonl");
        // This matrix tests Docker/configuration failures, not whichever ports
        // the developer's live stack currently uses. Port probes have their own
        // real-socket tests in doctor.test.ts.
        const preload = join(directory, "ports-preload.ts");
        const portsModule = resolve(import.meta.dir, "../src/ports.ts");
        writeFileSync(
          preload,
          `import { mock } from "bun:test";\nconst ports = await import(${JSON.stringify(portsModule)});\nmock.module(${JSON.stringify(portsModule)}, () => ({ ...ports, firstUnavailablePort: async () => null }));\n`
        );
        const paths = installationPaths(join(directory, "installation"));
        const before = new Map<string, string>();
        if (installed) {
          mkdirSync(paths.directory);
          const environment = replaceEnvironmentValue(
            createEnvironment({ version: "1.2.3" }),
            "OPENTEAM_API_PORT",
            String(server.port)
          );
          writeFileSync(paths.environment, environment, {
            mode: id === "env-permissions" ? 0o644 : 0o600,
          });
          writeFileSync(paths.compose, "services:\n  server:\n    image: example/server\n");
          writeManifest(paths, {
            schemaVersion: 1,
            repository: "example/team",
            version: "1.2.3",
            composeUrl: "https://example.test/compose.yaml",
            installedAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            ownerUsername: "example",
          });
          for (const file of [paths.environment, paths.compose, paths.manifest])
            before.set(file, readFileSync(file, "utf8"));
        }
        if (id !== "missing-cli") {
          writeFileSync(join(bin, "docker"), stub, { mode: 0o755 });
          writeFileSync(join(bin, "docker-compose"), stub, { mode: 0o755 });
        }
        const child = Bun.spawn(
          [
            process.execPath,
            "--preload",
            preload,
            resolve(import.meta.dir, "../src/main.ts"),
            "doctor",
            "--dir",
            paths.directory,
          ],
          {
            env: {
              ...process.env,
              PATH: bin,
              NO_COLOR: "1",
              OPENTEAM_TEST_SCENARIO: id,
              OPENTEAM_TEST_CALLS: calls,
            },
            stdout: "pipe",
            stderr: "pipe",
          }
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const output = `${stdout}\n${stderr}`.replace(/\s+/g, " ");
        const success = ["healthy", "compose-fallback"].includes(id);
        expect(exitCode).toBe(success ? 0 : 2);
        expect(output.replace(/ --dir '[^']*'/g, "")).toContain(
          id === "missing-cli" && process.platform === "linux"
            ? "Install Docker Engine"
            : recommendation
        );
        if (!success) {
          expect(output).toContain("NEEDS ATTENTION");
          expect(output).toContain("NEXT STEPS");
        }
        expect(stderr).toBe("");
        expect(output).not.toContain("Unexpected Docker command");
        expect(output).not.toContain("Unhandled");
        if (id === "missing-cli") {
          expect(output).toContain("1 failed");
          expect(output).toContain("1 not checked");
          expect(output).not.toContain("2 failed");
        }
        for (const [file, contents] of before) expect(readFileSync(file, "utf8")).toBe(contents);
        if (!installed) expect(existsSync(paths.directory)).toBe(false);
        const commands = existsSync(calls)
          ? readFileSync(calls, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line).args as string[])
          : [];
        expect(
          commands.every(
            (args) =>
              !args.some((arg) =>
                ["up", "down", "pull", "start", "stop", "restart", "rm", "prune"].includes(arg)
              )
          )
        ).toBe(true);
      } finally {
        server.stop(true);
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000
  );
});
