import { redactSensitiveText } from "@openteam/product-core/redaction";
import type { DoctorCheck } from "./doctor";
import type { ComposeProject } from "./docker";
import type { CommandRunner, RunResult } from "./process";

export const boundedDoctorRunner = (runner: CommandRunner): CommandRunner => ({
  run: (command, args, options) =>
    runner.run(command, args, {
      ...options,
      timeoutMs: Math.min(options?.timeoutMs ?? 10_000, 40_000),
      killSignal: "SIGKILL",
    }),
});

const failure = (result: RunResult): string =>
  result.error && "code" in result.error && result.error.code === "ETIMEDOUT"
    ? "check timed out"
    : redactSensitiveText(
        result.stderr.trim() || result.error?.message || "check could not run"
      ).slice(0, 500);

interface ContainerState {
  service: string;
  state: string;
  health: string;
  exitCode: number;
  restarts: number;
  startedAt: string;
}

export const checkContainers = (
  project: ComposeProject,
  runner: CommandRunner,
  expected: readonly string[]
): DoctorCheck[] => {
  const ids = project.run(["ps", "--all", "--quiet"]);
  if (ids.status !== 0) return [{ level: "fail", label: "Container health", detail: failure(ids) }];
  const containers = ids.stdout.trim().split(/\s+/).filter(Boolean);
  if (!containers.length)
    return [
      {
        level: "fail",
        label: "Container health",
        detail: "No containers found; run openteam start",
      },
    ];
  if (containers.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
    return [
      { level: "fail", label: "Container health", detail: "Docker returned invalid container IDs" },
    ];
  // Deliberately select only diagnostic fields: full inspect includes secrets.
  const inspect = runner.run("docker", [
    "inspect",
    "--format",
    '{"service":{{json (index .Config.Labels "com.docker.compose.service")}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"exitCode":{{.State.ExitCode}},"restarts":{{.RestartCount}},"startedAt":{{json .State.StartedAt}}}',
    ...containers,
  ]);
  let states: ContainerState[];
  try {
    if (inspect.status !== 0) throw new Error(failure(inspect));
    try {
      states = inspect.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error("Docker returned invalid container state");
    }
    if (
      !states.length ||
      states.some(
        (s) =>
          !s ||
          typeof s.service !== "string" ||
          typeof s.state !== "string" ||
          typeof s.health !== "string" ||
          !Number.isInteger(s.restarts) ||
          !Number.isInteger(s.exitCode) ||
          typeof s.startedAt !== "string"
      )
    )
      throw new Error("Docker returned invalid container state");
  } catch (error) {
    return [
      {
        level: "fail",
        label: "Container health",
        detail: error instanceof Error ? error.message : "Invalid container state",
      },
    ];
  }
  const checks: DoctorCheck[] = expected.map((service) => {
    const found = states.filter((s) => s.service === service);
    if (!found.length)
      return {
        level: "fail",
        label: `${service} container`,
        detail: "Missing; run openteam start",
      };
    const bad = found.find(
      (s) => s.state !== "running" || s.health === "unhealthy" || s.health === "starting"
    );
    const restarting = found.find(
      (s) => s.restarts >= 3 && Date.now() - Date.parse(s.startedAt) < 300_000
    );
    const restartCount = found.reduce((count, s) => count + s.restarts, 0);
    return {
      level: bad || restarting ? "fail" : restartCount > 0 ? "warn" : "pass",
      label: `${service} container`,
      detail: bad
        ? `${bad.state}${bad.health !== "none" ? `, health ${bad.health}` : ""}; inspect openteam logs ${service}`
        : restarting
          ? `Restarted ${restarting.restarts} times and started again within 5 minutes; possible restart loop`
          : `${found.every((s) => s.health === "healthy") ? "Healthy" : "Running; no Docker healthcheck"}${restartCount ? `; ${restartCount} previous restart(s)` : "; no restarts"}`,
    };
  });
  const migrations = states.filter((s) => s.service === "migrate");
  checks.push({
    level: !migrations.length
      ? "warn"
      : migrations.every((s) => s.state === "exited" && s.exitCode === 0)
        ? "pass"
        : "fail",
    label: "Schema setup",
    detail: !migrations.length
      ? "No migration container to verify; inspect openteam logs migrate"
      : migrations.every((s) => s.state === "exited" && s.exitCode === 0)
        ? "Schema deployment completed successfully"
        : "Schema deployment has not completed successfully; inspect openteam logs migrate",
  });
  return checks;
};

const emit = String.raw`
await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(checks) + "\n", error => error ? reject(error) : resolve()));
`;

export const SERVER_PROBE =
  String.raw`
const checks = [];
const check = async (label, fn) => {
  try { checks.push({ label, level: "pass", detail: await fn() }); }
  catch (error) { checks.push({ label, level: "fail", detail: error instanceof Error ? error.message : String(error) }); }
};
await check("Database", async () => {
  if (!process.env.DATABASE_URL) throw new Error("Server database connection is not configured");
  const sql = new Bun.SQL(process.env.DATABASE_URL, { max: 1, connectionTimeout: 4 });
  try {
    await sql.unsafe("SET statement_timeout = '4000ms'");
    await sql.unsafe('SELECT 1 FROM "Bot" LIMIT 0');
    await sql.unsafe('SELECT 1 FROM "Run" LIMIT 0');
    await sql.unsafe('SELECT 1 FROM pgboss.queue LIMIT 0');
    return "Connected using server credentials; application and queue tables respond";
  } finally { await sql.close({ timeout: 1 }); }
});
for (const [label, query, healthy, problem] of [
  ["Pending jobs", "SELECT EXISTS (SELECT 1 FROM pgboss.job WHERE name IN ('bot-wake', 'bot-provision', 'transcript-project') AND state IN ('created', 'retry') AND start_after < now() - interval '5 minutes') AS pending", "No runnable jobs waiting longer than 5 minutes", "Jobs have waited over 5 minutes; worker may be busy or stuck"],
  ["Run leases", 'SELECT EXISTS (SELECT 1 FROM "BotRunLease" lease JOIN "Run" run ON run.id = lease."runId" WHERE run.status = \'running\' AND lease."expiresAt" < now() - interval \'30 seconds\') AS pending', "No running tasks with expired worker leases", "A running task has lost its worker lease; inspect openteam logs worker"],
]) {
  if (checks[0].level !== "pass") { checks.push({ label, level: "warn", detail: "Not tested; resolve the database connection first" }); continue; }
  const sql = new Bun.SQL(process.env.DATABASE_URL, { max: 1, connectionTimeout: 4 });
  try {
    await sql.unsafe("SET statement_timeout = '4000ms'");
    const [row] = await sql.unsafe(query);
    checks.push({ label, level: row.pending ? (label === "Run leases" ? "fail" : "warn") : "pass", detail: row.pending ? problem : healthy });
  } catch { checks.push({ label, level: "fail", detail: "Could not inspect queue or lease state; check schema setup and database logs" }); }
  finally { await sql.close({ timeout: 1 }); }
}
await check("Computer API", async () => {
  const url = new URL("/health", process.env.OPENTEAM_COMPUTER_URL ?? "http://127.0.0.1:8790");
  const response = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { authorization: "Bearer " + process.env.OPENTEAM_CONTROL_TOKEN } });
  const body = await response.json();
  if (!response.ok || body?.status !== "ready") throw new Error("Computer readiness failed (HTTP " + response.status + ")");
  return "Reachable and ready from the server";
});
` + emit;

export const WORKER_PROBE =
  String.raw`
const { readFileSync } = require("node:fs");
const { request } = require("node:http");
const checks = [];
let heartbeat;
try {
  heartbeat = JSON.parse(readFileSync("/tmp/openteam-worker-heartbeat.json", "utf8"));
  const age = Date.now() - heartbeat.updatedAt;
  if (!Number.isFinite(age) || age < -5000 || age > 20000 || typeof heartbeat.instance !== "string") throw new Error("Worker heartbeat is stale or invalid");
  checks.push({ level: "pass", label: "Worker heartbeat", detail: "Event loop heartbeat " + Math.max(0, Math.floor(age / 1000)) + "s ago" });
} catch (error) {
  checks.push({ level: "fail", label: "Worker heartbeat", detail: error.code === "ENOENT" ? "No worker heartbeat; update older images with openteam update --force" : error.message });
}
if (heartbeat && checks[0].level === "pass") {
  try {
    const body = await new Promise((resolve, reject) => {
      const req = request({ socketPath: "/tmp/openteam-worker-doctor.sock", method: "POST", path: "/queue" }, res => {
        let text = "";
        res.on("data", chunk => { text += chunk; if (text.length > 8192) req.destroy(new Error("Invalid queue test response")); });
        res.on("end", () => { try { resolve(JSON.parse(text)); } catch { reject(new Error("Invalid queue test response")); } });
      });
      const timer = setTimeout(() => req.destroy(new Error("Worker queue test timed out after 10s")), 10000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end();
    });
    if (body.ok !== true || body.instance !== heartbeat.instance || typeof body.consumer !== "string" || !Number.isFinite(body.durationMs)) throw new Error(body.error || "Worker did not confirm queue processing");
    checks.push({ level: "pass", label: "Queue round trip", detail: "Diagnostic job enqueued, consumed, and acknowledged in " + (body.durationMs / 1000).toFixed(1) + "s" });
  } catch (error) { checks.push({ level: "fail", label: "Queue round trip", detail: error.message }); }
} else checks.push({ level: "warn", label: "Queue round trip", detail: "Not tested; resolve the worker heartbeat first" });
` + emit;

export const STORAGE_PROBE =
  String.raw`
const fs = await import("node:fs/promises");
const { constants } = await import("node:fs");
const { join } = await import("node:path");
const checks = [];
const roots = process.env.OPENTEAM_DOCTOR_STORAGE === "computer"
  ? [process.env.OPENTEAM_WORKSPACE_ROOT || "/workspace"]
  : [process.env.OPENTEAM_AGENT_DATA_ROOT || "/home/box/agent-data", process.env.OPENTEAM_ASSET_ROOT || "/asset-store"];
if (process.env.OPENTEAM_DOCTOR_STORAGE === "computer" && process.getuid() === 0) {
  const identity = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  process.setgroups([]);
  process.setgid(identity(process.env.OPENTEAM_AGENT_GID, 1000));
  process.setuid(identity(process.env.OPENTEAM_AGENT_UID, 1001));
}
for (const root of roots) {
  let directory;
  try {
    directory = await fs.mkdtemp(join(root, ".openteam-doctor-"));
    const path = join(directory, "probe");
    await fs.writeFile(path, "openteam-doctor", { mode: 0o600 });
    if (await fs.readFile(path, "utf8") !== "openteam-doctor") throw new Error("Storage readback did not match");
    await fs.unlink(path);
    await fs.rmdir(directory);
    directory = undefined;
    if (root === process.env.OPENTEAM_AGENT_DATA_ROOT) {
      const agents = join(root, "agents");
      const entries = await fs.readdir(agents, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      for (const entry of entries) if (entry.isDirectory()) await fs.access(join(agents, entry.name), constants.R_OK | constants.W_OK | constants.X_OK);
    }
    checks.push({ level: "pass", label: root, detail: "Read, write, and delete verified as UID " + process.getuid() });
  } catch (error) { checks.push({ level: "fail", label: root, detail: "Storage permissions failed as UID " + process.getuid() + ": " + error.message }); }
  finally { if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}
` + emit;

export const runServiceProbe = (
  project: ComposeProject,
  service: string,
  script: string,
  labels: readonly string[],
  storage = false
): DoctorCheck[] => {
  const command = service === "worker" ? "node" : "bun";
  // Node -e requires an async wrapper; Bun accepts it too.
  const result = project.run(
    [
      "exec",
      "--no-TTY",
      ...(storage ? ["--env", `OPENTEAM_DOCTOR_STORAGE=${service}`] : []),
      service,
      command,
      "-e",
      `(async () => {${script}})().catch(() => process.exitCode = 1)`,
    ],
    { timeoutMs: 15_000 }
  );
  try {
    if (result.status !== 0) throw new Error(failure(result));
    const checks: unknown = JSON.parse(result.stdout);
    if (
      !Array.isArray(checks) ||
      checks.length !== labels.length ||
      checks.some(
        (c, i) =>
          !c ||
          (!storage && c.label !== labels[i]) ||
          !["pass", "warn", "fail"].includes(c.level) ||
          typeof c.detail !== "string"
      )
    )
      throw new Error("Probe returned an invalid result");
    return checks.map((c, i) => ({
      level: c.level,
      label: labels[i]!,
      detail: redactSensitiveText(c.detail).slice(0, 500),
    }));
  } catch (error) {
    return labels.map((label) => ({
      level: "fail",
      label,
      detail: error instanceof Error ? error.message : "Probe failed",
    }));
  }
};
