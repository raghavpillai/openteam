import {
  accessSync,
  existsSync,
  constants as fsConstants,
  readFileSync,
  statfsSync,
} from "node:fs";
import { createServer } from "node:net";
import type { EventEmitter } from "node:events";
import { redactSensitiveText } from "@openbot/product-core/redaction";
import { arch, freemem, totalmem } from "node:os";
import { dirname } from "node:path";
import type { InstallationPaths } from "./config";
import {
  environmentModeIsPrivate,
  installationExists,
  parseEnvironment,
  readManifest,
} from "./config";
import {
  API_PORT,
  MINIMUM_RECOMMENDED_DISK_BYTES,
  MINIMUM_RECOMMENDED_MEMORY_BYTES,
  PROJECT_NAME,
  VIEWER_PORT_END,
  VIEWER_PORT_START,
} from "./constants";
import {
  ComposeProject,
  dockerDaemon,
  dockerVersion,
  findCompose,
  MINIMUM_COMPOSE_VERSION,
} from "./docker";
import { checkHealth } from "./health";
import type { CommandRunner } from "./process";
import { inspectPublicReadiness } from "./public-readiness";

type CheckLevel = "pass" | "warn" | "fail";

export interface DoctorCheck {
  level: CheckLevel;
  label: string;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  installed: boolean;
  checks: readonly DoctorCheck[];
}

const nearestExistingDirectory = (path: string): string => {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
  return current;
};

const formatBytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export const portAvailable = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.unref();
    (server as unknown as EventEmitter).once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

const portRangeAvailable = async (host: string): Promise<number | null> => {
  const ports = [API_PORT];
  for (let port = VIEWER_PORT_START; port <= VIEWER_PORT_END; port += 1) ports.push(port);
  for (const port of ports) {
    if (!(await portAvailable(host, port))) return port;
  }
  return null;
};

export const runDoctor = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  requestedProjectName = PROJECT_NAME
): Promise<DoctorResult> => {
  const checks: DoctorCheck[] = [];
  const installed = installationExists(paths);
  const machineArchitecture = arch();
  checks.push(
    ["x64", "arm64"].includes(machineArchitecture)
      ? { level: "pass", label: "Platform", detail: `${process.platform}/${machineArchitecture}` }
      : {
          level: "fail",
          label: "Platform",
          detail: `${process.platform}/${machineArchitecture} is not supported by OpenBot images`,
        }
  );

  const memory = totalmem();
  checks.push({
    level: memory >= MINIMUM_RECOMMENDED_MEMORY_BYTES ? "pass" : "warn",
    label: "Memory",
    detail: `${formatBytes(memory)} total, ${formatBytes(freemem())} currently available`,
  });
  try {
    const existingDirectory = nearestExistingDirectory(paths.directory);
    accessSync(existingDirectory, fsConstants.W_OK);
    checks.push({
      level: "pass",
      label: "Installation directory",
      detail: `${existingDirectory} is writable`,
    });
    const filesystem = statfsSync(existingDirectory);
    const available = Number(filesystem.bavail) * Number(filesystem.bsize);
    checks.push({
      level: available >= MINIMUM_RECOMMENDED_DISK_BYTES ? "pass" : "warn",
      label: "Disk",
      detail: `${formatBytes(available)} available near ${paths.directory}`,
    });
  } catch (error) {
    checks.push({
      level: "fail",
      label: "Installation directory",
      detail: `not writable or measurable: ${error instanceof Error ? error.message : error}`,
    });
  }

  const docker = dockerVersion(runner);
  checks.push({
    level: docker.status === 0 ? "pass" : "fail",
    label: "Docker CLI",
    detail: docker.status === 0 ? docker.stdout.trim() : "not found",
  });
  if (docker.status === 0) {
    const daemon = dockerDaemon(runner);
    checks.push({
      level: daemon.status === 0 ? "pass" : "fail",
      label: "Docker daemon",
      detail: daemon.status === 0 ? `server ${daemon.stdout.trim()}` : "not reachable",
    });
  }
  const compose = findCompose(runner);
  checks.push({
    level: compose?.supported ? "pass" : "fail",
    label: "Docker Compose",
    detail: compose
      ? `${compose.version}${compose.supported ? "" : `; OpenBot requires ${MINIMUM_COMPOSE_VERSION}+`}`
      : "not found",
  });

  if (!installed) {
    checks.push({
      level: "warn",
      label: "Installation",
      detail: `OpenBot is not installed at ${paths.directory}`,
    });
    const unavailablePort = await portRangeAvailable("127.0.0.1");
    checks.push({
      level: unavailablePort === null ? "pass" : "fail",
      label: "Local ports",
      detail:
        unavailablePort === null
          ? `${API_PORT} and ${VIEWER_PORT_START}-${VIEWER_PORT_END} are available`
          : `port ${unavailablePort} is already in use`,
    });
  } else {
    const manifest = readManifest(paths);
    checks.push({
      level: manifest ? "pass" : "fail",
      label: "Installation",
      detail: manifest ? `OpenBot ${manifest.version} at ${paths.directory}` : "manifest missing",
    });
    checks.push({
      level: environmentModeIsPrivate(paths) ? "pass" : "fail",
      label: "Secrets",
      detail: environmentModeIsPrivate(paths)
        ? "configuration permissions are private"
        : `${paths.environment} is readable by other users`,
    });
    const project = compose?.supported
      ? new ComposeProject(paths, compose, runner, manifest?.projectName || requestedProjectName)
      : null;
    if (project) {
      const validation = project.run(["config", "--quiet"]);
      checks.push({
        level: validation.status === 0 ? "pass" : "fail",
        label: "Compose configuration",
        detail:
          validation.status === 0
            ? "valid"
            : validation.stderr.trim() || validation.stdout.trim() || "invalid",
      });
    }
    try {
      const values = parseEnvironment(readFileSync(paths.environment, "utf8"));
      const requiredSecrets = [
        "OPENBOT_POSTGRES_PASSWORD",
        "OPENBOT_CONTROL_TOKEN",
        "OPENBOT_AUTH_SECRET",
        "OPENBOT_PROXY_SECRET",
      ];
      const missingSecrets = requiredSecrets.filter((key) => (values.get(key)?.length ?? 0) < 32);
      checks.push({
        level: missingSecrets.length === 0 ? "pass" : "fail",
        label: "Secret values",
        detail:
          missingSecrets.length === 0
            ? "database, control, authentication, and proxy secrets are configured"
            : `missing or too short: ${missingSecrets.join(", ")}`,
      });
      checks.push({
        level: manifest?.ownerUsername ? "pass" : "fail",
        label: "Owner account",
        detail: manifest?.ownerUsername
          ? `configured for ${manifest.ownerUsername}`
          : "not configured; run openbot setup",
      });
      const accessMode = values.get("OPENBOT_ACCESS_MODE") || "local";
      const publicUrl = values.get("OPENBOT_PUBLIC_URL") || "";
      const apiIsLoopback = values.get("OPENBOT_BIND_HOST") === "127.0.0.1";
      const viewersAreLoopback =
        (values.get("OPENBOT_VIEWER_BIND_HOST") || values.get("OPENBOT_BIND_HOST")) === "127.0.0.1";
      let exposure: DoctorCheck;
      if (accessMode === "https" || accessMode === "proxy") {
        exposure =
          publicUrl.startsWith("https://") && apiIsLoopback && viewersAreLoopback
            ? {
                level: "pass",
                label: "Network exposure",
                detail:
                  accessMode === "https"
                    ? `public HTTPS through bundled Caddy at ${publicUrl}; internal ports are loopback-only`
                    : `public HTTPS through an external proxy at ${publicUrl}; OpenBot ports are loopback-only`,
              }
            : {
                level: "fail",
                label: "Network exposure",
                detail:
                  "HTTPS mode requires an https:// public URL and loopback-only internal ports",
              };
      } else if (accessMode === "http") {
        exposure = {
          level: "warn",
          label: "Network exposure",
          detail: `${publicUrl || "public HTTP"} is unencrypted; passwords and sessions are exposed in transit`,
        };
      } else if (accessMode === "private") {
        exposure = {
          level: "warn",
          label: "Network exposure",
          detail: `${publicUrl || "private HTTP"} must remain behind a trusted LAN or VPN`,
        };
      } else {
        exposure =
          apiIsLoopback && viewersAreLoopback
            ? {
                level: "pass",
                label: "Network exposure",
                detail: "API and screen viewers are loopback-only",
              }
            : {
                level: "fail",
                label: "Network exposure",
                detail: "local mode must keep the API and screen viewers on loopback",
              };
      }
      checks.push(exposure);

      if (project) {
        const running = project.run(["ps", "--status", "running", "--services"]);
        const runningServices = new Set(
          running.status === 0
            ? running.stdout
                .split(/\r?\n/)
                .map((value) => value.trim())
                .filter(Boolean)
            : []
        );
        const expected = ["postgres", "server", "worker", "computer"];
        if (accessMode === "https") expected.push("caddy");
        const missing = expected.filter((service) => !runningServices.has(service));
        checks.push({
          level: running.status === 0 && missing.length === 0 ? "pass" : "fail",
          label: "Compose services",
          detail:
            running.status !== 0
              ? running.stderr.trim() || running.stdout.trim() || "could not read service state"
              : missing.length
                ? `not running: ${missing.join(", ")}`
                : `${expected.join(", ")} are running`,
        });
      }

      if (["https", "proxy", "http"].includes(accessMode) && publicUrl) {
        const readiness = await inspectPublicReadiness(publicUrl);
        checks.push({
          level: readiness.dns.ok ? "pass" : "fail",
          label: "Public DNS",
          detail: readiness.dns.detail,
        });
        if (readiness.tls) {
          checks.push({
            level: readiness.tls.ok ? "pass" : "fail",
            label: "TLS certificate",
            detail: readiness.tls.detail,
          });
        }
        checks.push({
          level: readiness.endpoint.ok ? "pass" : "fail",
          label: "Public endpoint",
          detail: readiness.endpoint.detail,
        });
      }
    } catch (error) {
      checks.push({
        level: "fail",
        label: "Configuration",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const health = await checkHealth(paths);
    checks.push({
      level: health.ok ? "pass" : "fail",
      label: "OpenBot health",
      detail: health.ok ? `${health.detail} at ${health.url}` : `${health.url}: ${health.detail}`,
    });
    if (health.ok && health.agent) {
      checks.push({
        level: health.agent === "ready" ? "pass" : "warn",
        label: "Model authentication",
        detail:
          health.agent === "ready"
            ? "OpenAI Codex authentication is ready"
            : `runtime reports ${health.agent}; complete OpenBot onboarding before running agents`,
      });
    }
  }
  return { ok: !checks.some((check) => check.level === "fail"), installed, checks };
};

export const printDoctor = (result: DoctorResult): void => {
  const marks: Record<CheckLevel, string> = { pass: "✓", warn: "!", fail: "✗" };
  for (const check of result.checks) {
    console.log(`${marks[check.level]} ${check.label}: ${redactSensitiveText(check.detail)}`);
  }
  console.log(
    result.ok
      ? "\nOpenBot doctor found no blocking problems."
      : "\nOpenBot doctor found blocking problems."
  );
};
