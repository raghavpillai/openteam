import { describe, expect, test } from "bun:test";
import {
  chmodSync,
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

const cases: Array<[string, string, boolean?]> = [
  ["missing-cli", "Install Docker Desktop"],
  ["cli-permission", "executable's permissions"],
  ["cli-broken", "repair or update the Docker CLI"],
  ["daemon-stopped", "Start your Docker runtime"],
  ["daemon-permission", "your user has access"],
  ["daemon-api", "DOCKER_API_VERSION"],
  ["daemon-tls", "TLS certificates"],
  ["daemon-context", "docker context use <name>"],
  ["daemon-dns", "DNS or VPN"],
  ["daemon-ssh", "Verify SSH access"],
  ["compose-missing", "2.20.0 or newer"],
  ["compose-old", "2.20.0 or newer"],
  ["compose-fallback", "SETUP NEEDED"],
  ["invalid-manifest", "known-good backup", true],
  ["env-permissions", "owner-only", true],
  ["missing-secrets", "credentials must remain consistent", true],
  ["compose-invalid", "configuration files", true],
  ["services-stopped", "openteam start", true],
  ["migration-failed", "openteam logs migrate", true],
  ["database-down", "openteam logs postgres", true],
  ["storage-permission", "service's user", true],
  ["probe-invalid", "invalid diagnostic response", true],
  ["health-503", "HTTP 503", true],
  ["health-invalid", "readiness is unknown", true],
  ["health-version", "API port belongs to this installation", true],
  ["model-401", "reconnect it", true],
  ["model-quota", "quota or billing", true],
  ["model-timeout", "network access", true],
  ["healthy", "ALL SYSTEMS READY", true],
];

// The stub only responds to diagnostic commands; unexpected commands fail closed.
// It runs in a separate process so PATH/permission errors exercise SystemCommandRunner.
const stub = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { SERVER_PROBE, WORKER_PROBE, STORAGE_PROBE } from ${JSON.stringify(resolve(import.meta.dir, "../src/doctor-probes.ts"))};
const scenario = process.env.OPENTEAM_TEST_SCENARIO;
const args = process.argv.slice(2);
const standalone = process.argv[1].endsWith('docker-compose');
appendFileSync(process.env.OPENTEAM_TEST_CALLS, JSON.stringify({ standalone, args }) + '\\n');
const ok = stdout => { console.log(stdout); process.exit(0); };
const fail = stderr => { console.error(stderr); process.exit(1); };
if (args[0] === '--version') {
  if (scenario === 'cli-broken') fail('dyld: Library not loaded: libdocker.dylib');
  ok('Docker version 28.2.2');
}
if (args[0] === 'info') {
  const failures = {
    'daemon-stopped': 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
    'daemon-permission': 'permission denied while trying to connect to the Docker daemon socket',
    'daemon-api': 'client version 1.24 is too old. Minimum supported API version is 1.44',
    'daemon-tls': 'x509: certificate has expired',
    'daemon-context': 'context "old-engine": context not found',
    'daemon-dns': 'dial tcp: lookup docker.internal: no such host',
    'daemon-ssh': 'Permission denied (publickey).',
  };
  if (failures[scenario]) fail(failures[scenario]);
  ok('28.2.2');
}
if ((args[0] === 'compose' && args[1] === 'version') || (standalone && args[0] === 'version')) {
  if (scenario === 'compose-missing') fail(standalone ? 'standalone Compose is unavailable' : 'compose is not a docker command');
  if (scenario === 'compose-fallback' && !standalone) fail('compose is not a docker command');
  ok(scenario === 'compose-old' ? 'Docker Compose version v1.29.2' : 'Docker Compose version v5.1.3');
}
if (args.includes('config') && args.includes('--quiet')) {
  if (scenario === 'compose-invalid') fail('yaml: line 8: did not find expected key');
  ok('');
}
const services = scenario === 'services-stopped' ? ['postgres'] : ['postgres', 'server', 'worker', 'computer'];
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
    const errors = { 'model-401': 'HTTP 401: unauthorized', 'model-quota': 'HTTP 429: quota exceeded', 'model-timeout': 'The model connection test timed out' };
    ok(JSON.stringify(errors[scenario] ? {ok:false,error:errors[scenario]} : {ok:true}));
  }
  if (scenario === 'probe-invalid') ok('{broken');
  const labels = script.includes(SERVER_PROBE) ? ['Database','Pending jobs','Run leases','Computer API']
    : script.includes(WORKER_PROBE) ? ['Worker heartbeat','Queue round trip']
    : script.includes(STORAGE_PROBE) ? args.includes('computer') ? ['workspace'] : ['agents','assets'] : [];
  if (!labels.length) fail('Unexpected diagnostic script');
  ok(JSON.stringify(labels.map(label => ({ label,
    level: scenario === 'database-down' && label === 'Database' || scenario === 'storage-permission' && ['workspace','agents','assets'].includes(label) ? 'fail' : 'pass',
    detail: scenario === 'database-down' && label === 'Database' ? 'connect ECONNREFUSED 127.0.0.1:5432'
      : scenario === 'storage-permission' && ['workspace','agents','assets'].includes(label) ? 'EACCES: permission denied as UID 1000' : 'Verified'
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
            if (id === "health-503" || id === "services-stopped")
              return new Response("unavailable", { status: 503 });
            if (id === "health-invalid") return new Response("<html>wrong server</html>");
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
        const paths = installationPaths(join(directory, "installation"));
        const before = new Map<string, string>();
        if (installed) {
          mkdirSync(paths.directory);
          let environment = replaceEnvironmentValue(
            createEnvironment({ version: "1.2.3" }),
            "OPENTEAM_API_PORT",
            String(server.port)
          );
          if (id === "missing-secrets")
            environment = replaceEnvironmentValue(environment, "OPENTEAM_CONTROL_TOKEN", "short");
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
          if (id === "invalid-manifest") writeFileSync(paths.manifest, "{broken");
          for (const file of [paths.environment, paths.compose, paths.manifest])
            before.set(file, readFileSync(file, "utf8"));
        }
        if (id !== "missing-cli") {
          writeFileSync(join(bin, "docker"), stub, { mode: 0o755 });
          writeFileSync(join(bin, "docker-compose"), stub, { mode: 0o755 });
          if (id === "cli-permission") chmodSync(join(bin, "docker"), 0o644);
        }
        const child = Bun.spawn(
          [
            process.execPath,
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
