import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createEnvironment,
  installationPaths,
  parseEnvironment,
  replaceEnvironmentValue,
  writeManifest,
} from "../apps/cli/src/config";
import { composeProcessEnvironment } from "../apps/cli/src/docker";

// All mutations are scoped to a fresh project with its own volumes and loopback API port.
// Never accept an existing project/directory as input to a destructive chaos run.
const root = resolve(import.meta.dir, "..");
const id = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const project = `openteam-chaos-${id}`;
const output = join(root, "output/health-chaos", id);
const context = join(output, "context");
mkdirSync(context, { recursive: true });
const paths = installationPaths(join(output, "installation"));
mkdirSync(paths.directory);
const cli = join(root, "apps/cli/dist/openteam.js");
const results: object[] = [];
const tags: string[] = [];
let config: any;
let started = false;
let authToken = "";

const run = async (
  cmd: string[],
  options: { input?: string; expected?: number; log?: string; timeout?: number } = {}
) => {
  const child = Bun.spawn(cmd, {
    cwd: root,
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
    env: composeProcessEnvironment(paths, { ...process.env, NO_COLOR: "1", TERM: "dumb" }),
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 180_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (options.log) writeFileSync(join(output, options.log), stdout + stderr);
    if (options.expected !== undefined && code !== options.expected)
      throw new Error(
        `${cmd[0]} ${cmd[1]} failed (${code}); see ${options.log ?? "captured command output"}: ${(stderr || stdout).slice(-1200)}`
      );
    return { code, text: stdout + stderr };
  } finally {
    clearTimeout(timer);
  }
};
const compose = (args: string[], options: Parameters<typeof run>[1] = {}) =>
  run(
    [
      "docker",
      "compose",
      "--project-name",
      project,
      "--project-directory",
      paths.directory,
      "--env-file",
      paths.environment,
      "--file",
      paths.compose,
      ...args,
    ],
    { expected: 0, ...options }
  );
const exec = (service: string, command: string[], options: Parameters<typeof run>[1] = {}) =>
  compose(["exec", "--no-TTY", "--user", "0", service, ...command], options);
const saveConfig = () => writeFileSync(paths.compose, JSON.stringify(config, null, 2));
const record = (value: object) => {
  results.push(value);
  writeFileSync(join(output, "results.json"), JSON.stringify({ project, results }, null, 2));
};
const command = (name: "health" | "doctor", label: string) =>
  run(["node", cli, name, "--dir", paths.directory], {
    log: `${label}-${name}.txt`,
    timeout: 100_000,
  });
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
// Compose start also restarts completed init dependencies. Restore only the faulted container.
const startService = async (service: string) => {
  const result = await compose(["ps", "--all", "--quiet", service]);
  const container = result.text.trim();
  assert(/^[a-f0-9]{12,64}$/.test(container), `Expected one isolated ${service} container`);
  await run(["docker", "start", container], { expected: 0 });
};
const waitHealthy = async (label: string) => {
  const deadline = Date.now() + 100_000;
  let result;
  do {
    result = await command("health", label);
    if (result.code === 0) return;
    await Bun.sleep(2_000);
  } while (Date.now() < deadline);
  throw new Error(`Recovery did not become healthy: ${label}. ${result?.text.slice(0, 1200)}`);
};
const fault = async (
  name: string,
  inject: () => Promise<unknown>,
  restore: () => Promise<unknown>,
  expected: RegExp,
  healthFailure = true
) => {
  console.log(`[chaos] ${name}`);
  const startedAt = Date.now();
  try {
    await inject();
    // Production worker interval is 30s/retries 3; this test stack uses 2s/retries 1.
    if (healthFailure) {
      const deadline = Date.now() + 50_000;
      while (true) {
        const result = await command("health", name);
        if (result.code === 2) break;
        assert(Date.now() < deadline, `${name}: health missed the fault`);
        await Bun.sleep(2_000);
      }
    } else
      assert(
        (await command("health", name)).code === 0,
        `${name}: optional provider failure broke infrastructure readiness`
      );
    const doctor = await command("doctor", name);
    const failures = doctor.text
      .split("\n")
      .filter((line) => line.trimStart().startsWith("✗"))
      .join("\n");
    assert(
      doctor.code === 2 && expected.test(failures),
      `${name}: doctor missed or misdiagnosed the fault: ${doctor.text.slice(-1800)}`
    );
    record({ name, detected: true, durationMs: Date.now() - startedAt });
  } finally {
    await restore();
    await waitHealthy(`${name}-recovered`);
    const doctor = await command("doctor", `${name}-recovered`);
    assert(doctor.code === 0, `${name}: doctor failed after recovery: ${doctor.text.slice(-1800)}`);
    record({ name: `${name}-recovered`, healthy: true, doctorPassed: true });
  }
};

const canaryTurn = async (label: string) => {
  console.log(`[canary] ${label}`);
  const origin = parseEnvironment(readFileSync(paths.environment, "utf8")).get(
    "OPENTEAM_PUBLIC_URL"
  )!;
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(origin + "/api/v0" + path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as any;
    assert(response.ok, `Canary ${path} failed: HTTP ${response.status}`);
    return data;
  };
  await api("/client-bootstrap");
  await api("/events/poll?waitMs=0");
  const bot = await api("/bots", {
    clientRequestId: randomUUID(),
    name: `Health chaos ${label}`,
    instructions: "Reply with OPENTEAM_CHAOS_OK using SendToUser.",
  });
  assert(typeof bot.conversationId === "string", "Canary bot was not created");
  await api(`/conversations/${bot.conversationId}/messages`, {
    content: "Send me OPENTEAM_CHAOS_OK",
    attachments: [],
    clientId: randomUUID(),
    timeZone: "UTC",
  });
  const deadline = Date.now() + 90_000;
  do {
    const snapshot = await api(`/conversations/${bot.conversationId}`);
    const completed = new Set(
      (snapshot.runs ?? [])
        .filter((run: any) => run.status === "completed")
        .map((run: any) => run.id)
    );
    if (
      (snapshot.messages ?? []).some(
        (message: any) =>
          completed.has(message.sourceRunId) && message.content?.includes("OPENTEAM_CHAOS_OK")
      )
    ) {
      record({
        name: `canary-${label}`,
        completed: true,
        verifies:
          "owner login -> client bootstrap/events -> API -> persisted message -> job queue -> worker -> computer -> provider -> visible response",
      });
      return;
    }
    assert(
      !(snapshot.runs ?? []).some((run: any) => run.status === "failed"),
      `Canary ${label} run failed`
    );
    await Bun.sleep(500);
  } while (Date.now() < deadline);
  throw new Error(`Canary ${label} did not complete`);
};

try {
  for (const app of ["worker", "server", "computer", "cli"]) {
    console.log(`[build] ${app}`);
    await run(["bun", "run", "--cwd", `apps/${app}`, "build"], {
      expected: 0,
      log: `build-${app}.txt`,
    });
  }
  for (const [from, to] of [
    ["apps/worker/dist/main.js", "worker.js"],
    ["apps/worker/dist/healthcheck.js", "healthcheck.js"],
    ["apps/server/dist/main.js", "server.js"],
    ["apps/computer/dist/main.js", "computer.js"],
    ["apps/computer/dist/provider-cli.js", "provider-cli.js"],
    ["scripts/health-chaos/provider.ts", "provider.ts"],
  ])
    cpSync(join(root, from!), join(context, to!));
  cpSync(join(root, "packages/db/prisma"), join(context, "prisma"), { recursive: true });
  cpSync(join(root, "packages/db/scripts"), join(context, "db-scripts"), { recursive: true });
  const sources: Record<string, string> = {
    worker:
      'FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY worker.js main.js\nCOPY healthcheck.js healthcheck.js\nUSER 1000:1000\nCMD ["node","main.js"]\n',
    server:
      'FROM oven/bun:1.3.8-slim\nWORKDIR /app\nCOPY server.js main.js\nUSER 1000:1000\nCMD ["bun","main.js"]\n',
    computer: `FROM ${process.env.OPENTEAM_CHAOS_COMPUTER_BASE || "ghcr.io/raghavpillai/openteam-computer:0.0.1"}\nCOPY computer.js /app/apps/computer/dist/main.js\nCOPY provider-cli.js /app/apps/computer/dist/provider-cli.js\n`,
    migrate: `FROM ${process.env.OPENTEAM_CHAOS_MIGRATE_BASE || "openteam-migrate:latest"}\nCOPY prisma /app/packages/db/prisma\nCOPY db-scripts /app/packages/db/scripts\n`,
  };
  for (const [service, dockerfile] of Object.entries(sources)) {
    console.log(`[image] ${service}`);
    const file = join(context, `${service}.Dockerfile`);
    writeFileSync(file, dockerfile);
    const tag = `${project}-${service}:test`;
    await run(["docker", "build", "--file", file, "--tag", tag, context], {
      expected: 0,
      log: `image-${service}.txt`,
      timeout: 600_000,
    });
    tags.push(tag);
  }
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = portProbe.port;
  portProbe.stop(true);
  let env = createEnvironment({ version: "0.0.0-chaos" });
  for (const [key, value] of Object.entries({
    OPENTEAM_API_PORT: String(port),
    OPENTEAM_PUBLIC_URL: `http://127.0.0.1:${port}`,
    OPENTEAM_AUTH_URL: `http://127.0.0.1:${port}`,
    OPENTEAM_AUTH_MODE: "required",
    OPENTEAM_IMAGE_PREFIX: project,
  }))
    env = replaceEnvironmentValue(env, key, value);
  writeFileSync(paths.environment, env, { mode: 0o600 });
  writeManifest(paths, {
    schemaVersion: 1,
    version: "0.0.0-chaos",
    projectName: project,
    ownerUsername: "chaos.fixture",
    repository: "test/chaos",
    composeUrl: "https://example.invalid/chaos",
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  config = Bun.YAML.parse(readFileSync(join(root, "deploy/compose.yaml"), "utf8"));
  config.name = project;
  delete config.services.caddy;
  config.services.computer.ports = [];
  for (const [name, service] of Object.entries<any>(config.services)) {
    service.labels = { "com.openteam.chaos": project };
    service.restart = "no";
    if (sources[name]) service.image = `${project}-${name}:test`;
    if (service.healthcheck)
      Object.assign(service.healthcheck, { interval: "2s", retries: 1, start_period: "45s" });
  }
  config.services.canary = {
    image: "oven/bun:1.3.8-slim",
    command: ["bun", "/provider.ts"],
    volumes: [`${context}/provider.ts:/provider.ts:ro`],
    labels: { "com.openteam.chaos": project },
  };
  saveConfig();
  started = true;
  console.log(`[stack] ${project}`);
  await compose(["up", "--detach", "--wait", "--wait-timeout", "180"], {
    log: "startup.txt",
    timeout: 240_000,
  });
  await compose(["exec", "--no-TTY", "computer", "openteam-pi-auth", "add-custom"], {
    input: JSON.stringify({
      id: "chaos",
      name: "Local chaos fixture",
      baseUrl: "http://canary:8799/v1",
      api: "openai-completions",
      model: "chaos-model",
      reasoning: false,
    }),
    log: "provider-setup.txt",
  });
  await compose(["exec", "--no-TTY", "computer", "openteam-pi-auth", "login", "chaos", "api_key"], {
    input: "synthetic-test-key\n",
    log: "provider-login.txt",
  });
  await compose(["restart", "computer"], { log: "provider-reload.txt" });
  await waitHealthy("provider-reload");
  await run(
    [
      "node",
      cli,
      "model",
      "use",
      "chaos",
      "chaos-model",
      "--thinking",
      "off",
      "--dir",
      paths.directory,
    ],
    { expected: 0, log: "model-setup.txt" }
  );
  await waitHealthy("baseline");
  const baseline = await command("doctor", "baseline");
  assert(baseline.code === 0, `Baseline doctor failed: ${baseline.text}`);
  record({ name: "healthy-baseline", detected: true });
  const origin = parseEnvironment(readFileSync(paths.environment, "utf8")).get(
    "OPENTEAM_PUBLIC_URL"
  )!;
  const username = "chaos.fixture";
  const password = randomBytes(24).toString("hex");
  await compose(["exec", "--no-TTY", "server", "bun", "/app/main.js", "owner-credentials"], {
    input: JSON.stringify({ operation: "setup", username, password }),
    log: "owner-setup.txt",
  });
  const denied = await fetch(origin + "/api/v0/client-bootstrap");
  assert(denied.status === 401, "Protected API accepted an unauthenticated request");
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, rememberMe: true }),
    signal: AbortSignal.timeout(10_000),
  });
  assert(
    login.ok && login.headers.has("set-auth-token"),
    `Owner login failed: HTTP ${login.status}`
  );
  authToken = login.headers.get("set-auth-token")!;
  await canaryTurn("baseline");
  const afterCanary = await command("doctor", "after-canary");
  assert(afterCanary.code === 0, `Doctor failed after canary: ${afterCanary.text}`);

  const sql = (query: string) =>
    exec("postgres", [
      "psql",
      "-U",
      "openteam",
      "-d",
      "openteam",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      query,
    ]);
  await fault(
    "worker-stopped",
    () => compose(["stop", "worker"]),
    () => startService("worker"),
    /not running: worker|worker container/
  );
  await fault(
    "worker-event-loop-frozen",
    () => compose(["kill", "--signal", "SIGSTOP", "worker"]),
    () => compose(["kill", "--signal", "SIGCONT", "worker"]),
    /Worker heartbeat|Queue round trip/
  );
  await fault(
    "worker-socket-missing",
    () => exec("worker", ["mv", "/tmp/openteam-worker-doctor.sock", "/tmp/chaos-socket"]),
    () => exec("worker", ["mv", "/tmp/chaos-socket", "/tmp/openteam-worker-doctor.sock"]),
    /Queue round trip/
  );
  await fault(
    "database-paused",
    () => compose(["pause", "postgres"]),
    () => compose(["unpause", "postgres"]),
    /Database/
  );
  await fault(
    "schema-missing",
    () => sql('ALTER TABLE "Bot" RENAME TO "Bot_chaos"'),
    () => sql('ALTER TABLE "Bot_chaos" RENAME TO "Bot"'),
    /Database/
  );
  await fault(
    "queue-schema-missing",
    () => sql("ALTER TABLE pgboss.queue RENAME TO queue_chaos"),
    () => sql("ALTER TABLE pgboss.queue_chaos RENAME TO queue"),
    /Database|Queue round trip/
  );
  await fault(
    "storage-denied",
    () => exec("server", ["chmod", "000", "/asset-store"]),
    () => exec("server", ["chmod", "700", "/asset-store"]),
    /storage|Storage/
  );
  await fault(
    "workspace-denied",
    () => exec("computer", ["chmod", "0500", "/workspace"]),
    () => exec("computer", ["chmod", "0770", "/workspace"]),
    /Computer API|Bot workspace storage/
  );
  await fault(
    "computer-stopped",
    () => compose(["stop", "computer"]),
    () => startService("computer"),
    /Computer API|not running: computer/
  );
  const token = config.services.computer.environment.OPENTEAM_CONTROL_TOKEN;
  await fault(
    "computer-token-mismatch",
    async () => {
      config.services.computer.environment.OPENTEAM_CONTROL_TOKEN =
        "intentional-chaos-token-mismatch";
      saveConfig();
      await compose(["up", "--detach", "--no-deps", "computer"]);
    },
    async () => {
      config.services.computer.environment.OPENTEAM_CONTROL_TOKEN = token;
      saveConfig();
      await compose(["up", "--detach", "--no-deps", "computer"]);
    },
    /Computer API|computer.*unavailable/
  );
  for (const mode of ["unauthorized", "quota", "unavailable"])
    await fault(
      `provider-${mode}`,
      () => exec("canary", ["sh", "-c", `printf %s ${mode} > /tmp/mode`]),
      () => exec("canary", ["rm", "-f", "/tmp/mode"]),
      /AI connection/,
      false
    );
  await canaryTurn("recovered");
  console.log(`[complete] ${results.length} checks; evidence: ${output}`);
} catch (error) {
  record({ failure: error instanceof Error ? error.message : String(error) });
  if (started) {
    await compose(["logs", "--tail", "100"], { expected: undefined, log: "failure-stack.txt" });
    await exec(
      "server",
      [
        "bun",
        "-e",
        "console.log(await (await fetch('http://127.0.0.1:8787/api/v0/health')).text())",
      ],
      { expected: undefined, log: "failure-health.txt" }
    );
  }
  throw error;
} finally {
  if (started) {
    await compose(["unpause"], { expected: undefined });
    await compose(["kill", "--signal", "SIGCONT", "worker"], { expected: undefined });
    await compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], {
      log: "cleanup.txt",
    });
  }
  for (const tag of tags) await run(["docker", "image", "rm", tag]);
}
