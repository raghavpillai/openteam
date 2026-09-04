import {
  accessSync,
  existsSync,
  constants as fsConstants,
  readFileSync,
  statfsSync,
} from "node:fs";
import { createServer } from "node:net";
import type { EventEmitter } from "node:events";
import { redactSensitiveText } from "@openteam/product-core/redaction";
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

export const firstUnavailablePort = async (
  host: string,
  ports: readonly number[]
): Promise<number | null> => {
  for (const port of ports) {
    if (!(await portAvailable(host, port))) return port;
  }
  return null;
};

export const viewerPorts = (): number[] => {
  const ports: number[] = [];
  for (let port = VIEWER_PORT_START; port <= VIEWER_PORT_END; port += 1) ports.push(port);
  return ports;
};

export const suggestApiPort = async (host: string, preferred = API_PORT): Promise<number> => {
  for (let offset = 0; offset < 100; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65_535) break;
    if (candidate >= VIEWER_PORT_START && candidate <= VIEWER_PORT_END) continue;
    if (await portAvailable(host, candidate)) return candidate;
  }
  return preferred;
};

export const runDoctor = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  requestedProjectName = PROJECT_NAME,
  options: { checkInstallPorts?: boolean } = {}
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
          detail: `${process.platform}/${machineArchitecture} is not supported by OpenTeam images`,
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
      ? `${compose.version}${compose.supported ? "" : `; OpenTeam requires ${MINIMUM_COMPOSE_VERSION}+`}`
      : "not found",
  });

  if (!installed) {
    checks.push({
      level: "warn",
      label: "Installation",
      detail: `OpenTeam is not installed at ${paths.directory}`,
    });
    const checkInstallPorts = options.checkInstallPorts ?? true;
    const unavailablePort = checkInstallPorts
      ? await firstUnavailablePort("127.0.0.1", [API_PORT, ...viewerPorts()])
      : null;
    checks.push({
      level: !checkInstallPorts ? "warn" : unavailablePort === null ? "pass" : "fail",
      label: "Local ports",
      detail: !checkInstallPorts
        ? "defaults will be checked after guided setup chooses the access mode"
        : unavailablePort === null
          ? `${API_PORT} and ${VIEWER_PORT_START}-${VIEWER_PORT_END} are available`
          : `port ${unavailablePort} is already in use`,
    });
  } else {
    const manifest = readManifest(paths);
    checks.push({
      level: manifest ? "pass" : "fail",
      label: "Installation",
      detail: manifest ? `OpenTeam ${manifest.version} at ${paths.directory}` : "manifest missing",
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
        "OPENTEAM_POSTGRES_PASSWORD",
        "OPENTEAM_CONTROL_TOKEN",
        "OPENTEAM_AUTH_SECRET",
        "OPENTEAM_PROXY_SECRET",
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
          : "not configured; run openteam setup",
      });
      const accessMode = values.get("OPENTEAM_ACCESS_MODE") || "local";
      const publicUrl = values.get("OPENTEAM_PUBLIC_URL") || "";
      const apiIsLoopback = values.get("OPENTEAM_BIND_HOST") === "127.0.0.1";
      const viewersAreLoopback =
        (values.get("OPENTEAM_VIEWER_BIND_HOST") || values.get("OPENTEAM_BIND_HOST")) ===
        "127.0.0.1";
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
                    : `public HTTPS through an external proxy at ${publicUrl}; OpenTeam ports are loopback-only`,
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
      label: "OpenTeam health",
      detail: health.ok ? `${health.detail} at ${health.url}` : `${health.url}: ${health.detail}`,
    });
    if (health.ok && health.inference) {
      checks.push({
        level: health.inference === "ready" ? "pass" : "warn",
        label: "Inference authentication",
        detail:
          health.inference === "ready"
            ? "Pi inference authentication is ready"
            : `runtime reports ${health.inference}; configure the selected inference provider before running agents`,
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
      ? "\nOpenTeam doctor found no blocking problems."
      : "\nOpenTeam doctor found blocking problems."
  );
};
