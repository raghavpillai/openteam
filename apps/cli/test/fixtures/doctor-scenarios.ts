import type { DoctorCheck, DoctorResult } from "../../src/doctor";
import { dockerFailureCheck } from "../../src/docker-diagnostics";
import type { RunResult } from "../../src/process";

export interface DoctorScenario {
  id: string;
  title: string;
  result: DoctorResult;
  action?: string;
  avoid?: string;
}

const pass = (label: string, detail: string): DoctorCheck => ({ label, detail, level: "pass" });
const healthy: DoctorCheck[] = [
  pass("Platform", "darwin/arm64"),
  pass("Memory", "64.0 GiB total, 2.9 GiB currently available"),
  pass("Installation directory", "/Users/example/.openteam is writable"),
  pass("Disk", "67.0 GiB available near /Users/example/.openteam"),
  pass("Docker CLI", "Docker version 28.2.2, build e6534b4"),
  pass("Docker daemon", "server 28.2.2"),
  pass("Docker Compose", "Docker Compose version v5.1.3"),
  pass("Installation", "OpenTeam 1.2.3 at /Users/example/.openteam"),
  pass("Secrets", "configuration permissions are private"),
  pass("Secret values", "database, control, authentication, and proxy secrets are configured"),
  pass("Owner account", "configured for example"),
  pass("Network exposure", "API and screen viewers are loopback-only"),
  pass("Compose services", "postgres, server, worker, computer are running"),
  pass("Database", "Connected to PostgreSQL"),
  pass("OpenTeam health", "ready at http://127.0.0.1:8787/api/v0/health"),
  pass("AI connection", "example/model responded in 0.2s (thinking medium)"),
];

const scenario = (
  id: string,
  title: string,
  changes: DoctorCheck[],
  action?: string,
  options: Partial<DoctorResult> & { avoid?: string } = {}
): DoctorScenario => {
  const checks = healthy
    .filter((c) => !changes.some((change) => change.label === c.label))
    .concat(changes);
  const { avoid, ...resultOptions } = options;
  return {
    id,
    title,
    action,
    avoid,
    result: {
      ok: !checks.some((c) => c.level === "fail"),
      installed: true,
      elapsedMs: 400,
      platform: "darwin",
      ...resultOptions,
      checks: resultOptions.checks ?? checks,
    },
  };
};
const issue = (label: string, detail: string, level: "fail" | "warn" = "fail"): DoctorCheck => ({
  label,
  detail,
  level,
});
const fresh = (check?: DoctorCheck): DoctorResult => {
  const checks = healthy.slice(0, 7).filter((c) => c.label !== check?.label);
  if (check) checks.push(check);
  checks.push(
    issue(
      "Installation",
      "First-time setup: the OpenTeam server has not been configured yet.",
      "warn"
    )
  );
  checks.push(pass("Local ports", "8787 and 6200–6299 are available"));
  if (check?.label === "Docker CLI") {
    const index = checks.findIndex((c) => c.label === "Docker daemon");
    checks.splice(index, 1);
    checks[checks.findIndex((c) => c.label === "Docker Compose")] = issue(
      "Docker Compose",
      "Not tested; make the Docker command available first.",
      "warn"
    );
  }
  return {
    ok: !checks.some((c) => c.level === "fail"),
    installed: false,
    checks,
    elapsedMs: 400,
    platform: "darwin",
  };
};
const failure = (stderr: string, code?: string): RunResult => ({
  status: 1,
  stdout: "",
  stderr,
  ...(code ? { error: Object.assign(new Error(`spawnSync docker ${code}`), { code }) } : {}),
});

const dockerCases: Array<[string, string, "cli" | "daemon", RunResult, string, NodeJS.Platform?]> =
  [
    [
      "docker-missing",
      "Docker is not installed (macOS)",
      "cli",
      failure("", "ENOENT"),
      "Install Docker Desktop",
    ],
    [
      "docker-missing-linux",
      "Docker is not installed (Linux)",
      "cli",
      failure("", "ENOENT"),
      "Install Docker Engine",
      "linux",
    ],
    [
      "docker-missing-windows",
      "Docker is not on PATH (Windows)",
      "cli",
      failure("", "ENOENT"),
      "on PATH",
      "win32",
    ],
    [
      "docker-executable-denied",
      "Docker executable cannot be run",
      "cli",
      failure("", "EACCES"),
      "executable's permissions",
    ],
    [
      "docker-cli-broken",
      "Docker executable fails to load",
      "cli",
      failure("dyld: Library not loaded: libdocker.dylib"),
      "repair or update",
    ],
    [
      "docker-stopped",
      "Docker Desktop is stopped",
      "daemon",
      failure(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
      ),
      "open -a Docker",
    ],
    [
      "docker-stopped-linux",
      "Linux Docker Engine is stopped",
      "daemon",
      failure("Cannot connect to the Docker daemon at unix:///var/run/docker.sock."),
      "systemctl start docker",
      "linux",
    ],
    [
      "docker-windows-pipe",
      "Docker Desktop's Windows pipe is missing",
      "daemon",
      failure(
        'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/info": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'
      ),
      "Open Docker Desktop",
      "win32",
    ],
    [
      "docker-colima-stopped",
      "An alternative Docker runtime is stopped",
      "daemon",
      failure(
        "Cannot connect to the Docker daemon at unix:///Users/example/.colima/default/docker.sock."
      ),
      "Start your Docker runtime",
    ],
    [
      "docker-permission",
      "Docker socket permission denied",
      "daemon",
      failure("permission denied while trying to connect to the Docker daemon socket"),
      "your user has access",
    ],
    [
      "docker-api-old",
      "Docker client is too old",
      "daemon",
      failure("client version 1.24 is too old. Minimum supported API version is 1.44"),
      "DOCKER_API_VERSION",
    ],
    [
      "docker-api-new",
      "Docker client is too new",
      "daemon",
      failure("client version 1.99 is too new. Maximum supported API version is 1.47"),
      "compatible versions",
    ],
    [
      "docker-context",
      "Saved Docker context is missing",
      "daemon",
      failure('context "old-engine": context not found'),
      "docker context use <name>",
    ],
    [
      "docker-remote",
      "Remote Docker host is unavailable",
      "daemon",
      failure("Cannot connect to the Docker daemon at tcp://build-host:2376"),
      "host is reachable",
    ],
    [
      "docker-dns",
      "Remote Docker hostname cannot resolve",
      "daemon",
      failure("dial tcp: lookup docker.internal: no such host"),
      "DNS or VPN",
    ],
    [
      "docker-tls",
      "Docker TLS certificate expired",
      "daemon",
      failure("x509: certificate has expired or is not yet valid"),
      "TLS certificates",
    ],
    [
      "docker-tls-protocol",
      "Docker endpoint uses the wrong protocol",
      "daemon",
      failure("server gave HTTP response to HTTPS client"),
      "DOCKER_TLS_VERIFY",
    ],
    [
      "docker-ssh",
      "Docker's remote SSH login failed",
      "daemon",
      failure("Permission denied (publickey)."),
      "Verify SSH access",
    ],
    [
      "docker-host-key",
      "Docker's remote SSH host key changed",
      "daemon",
      failure("Host key verification failed."),
      "host key",
    ],
    [
      "docker-timeout",
      "Docker engine does not respond",
      "daemon",
      failure("", "ETIMEDOUT"),
      "docker info",
    ],
    [
      "docker-remote-timeout",
      "Remote engine probe times out",
      "daemon",
      failure("Cannot connect to tcp://build-host:2376", "ETIMEDOUT"),
      "host is reachable",
    ],
    [
      "docker-no-output",
      "Docker fails without returning an error",
      "daemon",
      failure(""),
      "docker info",
    ],
  ];

export const doctorScenarios: DoctorScenario[] = [
  scenario(
    "unicode-path",
    "Unicode names and emoji in paths",
    [
      issue(
        "Installation directory",
        "EACCES: permission denied at /Users/团队/项目/👩🏽‍💻-Café/installation"
      ),
    ],
    "writable directory",
    { commandDirectory: "/Users/团队/项目/👩🏽‍💻-Café/installation" }
  ),
  scenario(
    "long-diagnostic",
    "Long errors with credentials and terminal escapes",
    [
      {
        ...issue("Docker daemon", "Docker denied access to its engine."),
        diagnostic:
          "permission denied; API_KEY=sk-proj-doctorInvalid0123456789012345\x1b[2J\r" +
          " socket-path-segment".repeat(60),
        action: "Check Docker socket permissions, then run docker info.",
      },
    ],
    "socket permissions"
  ),
  ...dockerCases.map(([id, title, kind, result, action, platform = "darwin"]) => ({
    id,
    title,
    action,
    result: { ...fresh(dockerFailureCheck(kind, result, platform)), platform },
  })),
  {
    id: "first-install",
    title: "Ready for first-time setup",
    result: fresh(),
    action: "openteam install",
  },
  scenario("healthy", "All checks pass", []),
  scenario(
    "compose-missing",
    "Neither Compose command is available",
    [
      issue(
        "Docker Compose",
        "Neither the Docker Compose plugin nor the standalone command could run."
      ),
    ],
    "2.20.0 or newer"
  ),
  scenario(
    "compose-old",
    "Compose version is unsupported",
    [issue("Docker Compose", "Docker Compose version v1.29.2; OpenTeam requires 2.20.0+")],
    "update Docker Desktop"
  ),
  scenario(
    "platform-unsupported",
    "Unsupported CPU architecture",
    [issue("Platform", "linux/ia32 is not supported by OpenTeam images")],
    "x64 or arm64"
  ),
  scenario(
    "low-memory",
    "Host has limited memory",
    [issue("Memory", "4.0 GiB total, 1.0 GiB currently available", "warn")],
    "8 GiB"
  ),
  scenario(
    "low-disk",
    "Installation disk is nearly full",
    [issue("Disk", "0.5 GiB available near /Users/example/.openteam", "warn")],
    "Free space"
  ),
  scenario(
    "directory-denied",
    "Installation directory is not writable",
    [issue("Installation directory", "EACCES: permission denied, access '/opt/openteam'")],
    "writable directory"
  ),
  scenario(
    "api-port-busy",
    "API port is already in use",
    [issue("Local ports", "port 8787 is already in use")],
    "another API port"
  ),
  scenario(
    "viewer-port-busy",
    "A viewer port is already in use",
    [issue("Local ports", "port 6204 is already in use")],
    "screen-viewer ports must be available"
  ),
  scenario(
    "incomplete-install",
    "Installation is missing files",
    [issue("Installation", "Installation files are missing; setup is incomplete.")],
    "known-good backup"
  ),
  scenario(
    "invalid-manifest",
    "Installation manifest is malformed",
    [
      issue(
        "Installation",
        "Invalid installation manifest at /Users/example/.openteam/installation.json"
      ),
    ],
    "known-good backup"
  ),
  scenario(
    "world-readable-env",
    "Configuration can be read by other users",
    [issue("Secrets", "/Users/example/.openteam/.env is readable by other users")],
    "owner-only"
  ),
  scenario(
    "missing-secrets",
    "Service credentials are missing",
    [issue("Secret values", "missing or too short: OPENTEAM_CONTROL_TOKEN")],
    "credentials must remain consistent"
  ),
  scenario(
    "invalid-compose",
    "Compose file has invalid YAML",
    [issue("Compose configuration", "yaml: line 8: did not find expected key")],
    "configuration files"
  ),
  scenario(
    "missing-owner",
    "First-run account setup is incomplete",
    [issue("Owner account", "not configured; run openteam setup")],
    "finish account"
  ),
  scenario(
    "unsafe-bind",
    "Local server is bound to a public interface",
    [issue("Network exposure", "local mode must keep the API and screen viewers on loopback")],
    "bind addresses"
  ),
  scenario(
    "services-stopped",
    "OpenTeam services are stopped",
    [
      issue("Compose services", "not running: server, worker, computer"),
      issue("AI connection", "Not tested; server is not running", "warn"),
    ],
    "openteam start"
  ),
  scenario(
    "service-query-error",
    "Docker cannot list service state",
    [issue("Compose services", "Docker API returned HTTP 500")],
    "could not list the services",
    { avoid: "openteam start" }
  ),
  scenario(
    "container-unhealthy",
    "Server container fails its health check",
    [issue("server container", "running, health unhealthy")],
    "openteam logs server"
  ),
  scenario(
    "restart-loop",
    "Worker repeatedly crashes",
    [issue("worker container", "running; 8 recent restarts")],
    "openteam logs worker"
  ),
  scenario(
    "migration-failed",
    "Database migration failed",
    [issue("Schema setup", "migrate exited with code 1")],
    "openteam logs migrate"
  ),
  scenario(
    "database-down",
    "Database connection is refused",
    [issue("Database", "connect ECONNREFUSED 127.0.0.1:5432")],
    "openteam logs postgres"
  ),
  scenario(
    "worker-stalled",
    "Worker has stopped responding",
    [
      issue("Worker heartbeat", "Worker heartbeat is stale by 120s"),
      issue("Queue round trip", "Not tested; resolve the worker heartbeat first", "warn"),
    ],
    "openteam logs worker"
  ),
  scenario(
    "storage-full",
    "Bot workspace is out of space",
    [issue("Bot workspace storage", "ENOSPC: no space left on device")],
    "free space"
  ),
  scenario(
    "storage-permission",
    "Worker cannot write agent storage",
    [issue("Worker agent storage", "EACCES: permission denied as UID 1000")],
    "service's user"
  ),
  scenario(
    "health-refused",
    "Server health endpoint is unreachable",
    [
      issue("OpenTeam health", "http://127.0.0.1:8787/api/v0/health: Connection refused"),
      issue("AI connection", "Not tested; resolve server health first", "warn"),
    ],
    "openteam status"
  ),
  scenario(
    "health-http-503",
    "Server reports unavailable",
    [issue("OpenTeam health", "http://127.0.0.1:8787/api/v0/health: HTTP 503")],
    "openteam logs"
  ),
  scenario(
    "health-wrong-version",
    "A different server release is responding",
    [issue("OpenTeam health", "expected release 1.2.3, but 1.1.0 is responding")],
    "API port belongs to this installation"
  ),
  scenario(
    "public-dns",
    "Public server DNS is not configured",
    [issue("Public DNS", "getaddrinfo ENOTFOUND team.example.test")],
    "public hostname"
  ),
  scenario(
    "public-tls",
    "Public HTTPS certificate is invalid",
    [issue("TLS certificate", "certificate has expired")],
    "openteam logs caddy"
  ),
  scenario(
    "public-proxy",
    "Reverse proxy returns a gateway error",
    [issue("Public endpoint", "https://team.example.test: HTTP 502")],
    "reverse proxy"
  ),
  scenario(
    "provider-expired",
    "Provider sign-in has expired",
    [issue("AI connection", "example/model: HTTP 401: unauthorized")],
    "reconnect it"
  ),
  scenario(
    "provider-quota",
    "Provider quota has been exhausted",
    [issue("AI connection", "example/model: HTTP 429: quota exceeded")],
    "quota or billing",
    { avoid: "reconnect" }
  ),
  scenario(
    "provider-timeout",
    "Model connection test times out",
    [issue("AI connection", "example/model: The model connection test timed out")],
    "network access",
    { avoid: "reconnect" }
  ),
  scenario(
    "model-unavailable",
    "Saved model is unavailable",
    [issue("AI connection", "example/model: model is unavailable")],
    "models available"
  ),
  scenario(
    "transcription-error",
    "Voice-note provider rejects its API key",
    [issue("Transcription", "HTTP 401: invalid provider key")],
    "Test connection"
  ),
  scenario(
    "transcription-legacy",
    "Server predates transcription diagnostics",
    [
      issue(
        "Transcription",
        "This server does not expose transcription diagnostics. Update the server to configure voice notes.",
        "warn"
      ),
    ],
    "openteam update"
  ),
  scenario(
    "transcription-server-error",
    "Transcription check cannot reach the server",
    [
      issue(
        "Transcription",
        "Could not check transcription through the OpenTeam server. Check the server connection and installation credentials."
      ),
    ],
    "installation control token"
  ),
  scenario(
    "all-skipped",
    "Checks cannot run yet",
    [issue("AI connection", "Not tested; server is not running", "warn")],
    undefined,
    { checks: [issue("AI connection", "Not tested; server is not running", "warn")] }
  ),
  scenario(
    "many-failures",
    "Several independent problems need attention",
    [
      issue("Secrets", "configuration is readable by other users"),
      issue("Network exposure", "invalid public URL"),
      issue("Schema setup", "migration failed"),
      issue("Database", "Connection refused"),
      issue("Worker heartbeat", "stale heartbeat"),
      issue("Computer API", "connection refused"),
      issue("Server agent storage", "permission denied"),
      issue("TLS certificate", "expired"),
      issue("Public DNS", "host not found"),
      issue("Public endpoint", "HTTP 502"),
      issue("Transcription", "provider request failed"),
      issue("AI connection", "HTTP 429"),
      issue("Disk", "0.5 GiB available", "warn"),
    ],
    "owner-only"
  ),
  scenario(
    "custom-directory",
    "Recovery targets a custom installation",
    [issue("OpenTeam health", "Connection refused")],
    "--dir '/srv/team'",
    { commandDirectory: "/srv/team" }
  ),
  scenario(
    "windows-directory",
    "PowerShell path contains an apostrophe",
    [issue("OpenTeam health", "Connection refused")],
    "--dir 'C:\\Users\\Sam''s Team'",
    { commandDirectory: "C:\\Users\\Sam's Team", platform: "win32" }
  ),
];
