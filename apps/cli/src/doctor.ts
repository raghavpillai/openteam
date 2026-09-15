import {
  accessSync,
  existsSync,
  constants as fsConstants,
  readFileSync,
  statfsSync,
} from "node:fs";
import { redactSensitiveText } from "@openteam/product-core/redaction";
import { arch, freemem, totalmem } from "node:os";
import { dirname } from "node:path";
import type { InstallationPaths } from "./config";
import {
  environmentModeIsPrivate,
  defaultInstallDirectory,
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
  probeCompose,
  MINIMUM_COMPOSE_VERSION,
} from "./docker";
import { checkHealth, withExpectedVersion, type HealthResult } from "./health";
import { checkInferenceConnection } from "./inference-connection";
import { checkTranscription } from "./transcription-check";
import {
  boundedDoctorRunner,
  checkContainers,
  runServiceProbe,
  SERVER_PROBE,
  WORKER_PROBE,
  STORAGE_PROBE,
} from "./doctor-probes";
import { renderDoctor, renderCompactDoctor } from "./doctor-ui";
import { commandDiagnostic, dockerFailureCheck } from "./docker-diagnostics";
import { firstUnavailablePort, viewerPorts } from "./ports";
import type { CommandRunner } from "./process";
import { inspectPublicReadiness } from "./public-readiness";
import { readRuntimeInferenceSettings } from "./runtime-settings";
import { foreignServerDetected, foreignServerMessage } from "./stack";

export { firstUnavailablePort, portAvailable, suggestApiPort, viewerPorts } from "./ports";

type CheckLevel = "pass" | "warn" | "fail";

export interface DoctorCheck {
  level: CheckLevel;
  label: string;
  detail: string;
  diagnostic?: string;
  action?: string;
}

export interface DoctorResult {
  ok: boolean;
  installed: boolean;
  checks: readonly DoctorCheck[];
  elapsedMs?: number;
  commandDirectory?: string;
  platform?: NodeJS.Platform;
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

export const runDoctor = async (
  paths: InstallationPaths,
  suppliedRunner: CommandRunner,
  requestedProjectName = PROJECT_NAME,
  options: {
    checkInstallPorts?: boolean;
    testInference?: boolean;
    deepChecks?: boolean;
    onProgress?: (stage: string) => void;
  } = {}
): Promise<DoctorResult> => {
  const started = Date.now();
  const runner = boundedDoctorRunner(suppliedRunner);
  const commandDirectory =
    paths.directory === defaultInstallDirectory() ? undefined : paths.directory;
  options.onProgress?.("Checking host and Docker");
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
  checks.push(
    docker.status === 0
      ? {
          level: "pass",
          label: "Docker CLI",
          detail: docker.stdout.trim(),
        }
      : dockerFailureCheck("cli", docker)
  );
  let daemonReady = false;
  if (docker.status === 0) {
    const daemon = dockerDaemon(runner);
    daemonReady = daemon.status === 0;
    checks.push(
      daemonReady
        ? {
            level: "pass",
            label: "Docker daemon",
            detail: `server ${daemon.stdout.trim()}`,
          }
        : dockerFailureCheck("daemon", daemon)
    );
  }
  const composeProbe = docker.status === 0 ? probeCompose(runner) : null;
  const compose = composeProbe?.command;
  checks.push(
    docker.status !== 0
      ? {
          level: "warn",
          label: "Docker Compose",
          detail: "Not tested; make the Docker command available first.",
        }
      : {
          level: compose?.supported ? "pass" : "fail",
          label: "Docker Compose",
          detail: compose
            ? `${compose.version}${compose.supported ? "" : `; OpenTeam requires ${MINIMUM_COMPOSE_VERSION}+`}`
            : "Neither the Docker Compose plugin nor the standalone command could run.",
          ...(!compose
            ? {
                diagnostic: composeProbe!.failures
                  .map(({ command, result }) => commandDiagnostic(command, result))
                  .join("\n"),
              }
            : {}),
        }
  );

  if (!installed) {
    checks.push({
      level: [paths.manifest, paths.environment, paths.compose].some(existsSync) ? "fail" : "warn",
      label: "Installation",
      detail: [paths.manifest, paths.environment, paths.compose].some(existsSync)
        ? `Installation files are missing at ${paths.directory}; setup is incomplete.`
        : `First-time setup: the OpenTeam server has not been configured at ${paths.directory} yet.`,
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
    options.onProgress?.("Checking configuration and services");
    let manifest;
    try {
      manifest = readManifest(paths);
    } catch {
      checks.push({
        level: "fail",
        label: "Installation",
        detail: `Invalid installation manifest at ${paths.manifest}; repair it before starting OpenTeam`,
      });
      return {
        ok: false,
        installed,
        checks,
        elapsedMs: Date.now() - started,
        commandDirectory,
        platform: process.platform,
      };
    }
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
    const project =
      compose?.supported && daemonReady
        ? new ComposeProject(paths, compose, runner, manifest?.projectName || requestedProjectName)
        : null;
    let runningServices: Set<string> | null = null;
    let environmentValues: ReadonlyMap<string, string> | null = null;
    if (project) {
      let validation;
      try {
        validation = project.run(["config", "--quiet"]);
      } catch {
        validation = {
          status: 1,
          stdout: "",
          stderr: "Could not read the Compose configuration or environment file",
        };
      }
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
      environmentValues = values;
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
        const services = new Set(
          running.status === 0
            ? running.stdout
                .split(/\r?\n/)
                .map((value) => value.trim())
                .filter(Boolean)
            : []
        );
        runningServices = services;
        const expected = ["postgres", "server", "worker", "computer"];
        if (accessMode === "https") expected.push("caddy");
        const missing = expected.filter((service) => !services.has(service));
        if (options.deepChecks) checks.push(...checkContainers(project, runner, expected));
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
    if (options.deepChecks && project) {
      options.onProgress?.("Testing database, computer, and worker");
      const probeService = (service: string, script: string, labels: string[], storage = false) => {
        checks.push(
          ...(runningServices?.has(service)
            ? runServiceProbe(project, service, script, labels, storage)
            : labels.map(
                (label): DoctorCheck => ({
                  level: "warn",
                  label,
                  detail: `Not tested; ${service} is not running`,
                })
              ))
        );
      };
      probeService("server", SERVER_PROBE, [
        "Database",
        "Pending jobs",
        "Run leases",
        "Computer API",
      ]);
      probeService("worker", WORKER_PROBE, ["Worker heartbeat", "Queue round trip"]);
      options.onProgress?.("Verifying storage permissions");
      probeService("server", STORAGE_PROBE, ["Server agent storage", "Server asset storage"], true);
      probeService("worker", STORAGE_PROBE, ["Worker agent storage", "Worker asset storage"], true);
      probeService("computer", STORAGE_PROBE, ["Bot workspace storage"], true);
    }
    let probe: HealthResult;
    try {
      probe = await checkHealth(paths);
    } catch {
      probe = {
        ok: false,
        url: paths.directory,
        detail: "Could not read the server connection configuration",
      };
    }
    const health = withExpectedVersion(probe, manifest?.version);
    const foreignServer = runningServices && foreignServerDetected(probe, runningServices);
    if (foreignServer && environmentValues) {
      checks.push({
        level: "fail",
        label: "OpenTeam health",
        detail: foreignServerMessage(runner, probe, environmentValues),
      });
    } else {
      checks.push({
        level: health.ok ? "pass" : "fail",
        label: "OpenTeam health",
        detail: health.ok ? `${health.detail} at ${health.url}` : `${health.url}: ${health.detail}`,
      });
    }
    if (health.ok && health.inference) {
      checks.push({
        level: health.inference === "ready" ? "pass" : "warn",
        label: "Inference",
        detail:
          health.inference === "ready"
            ? "provider credentials are configured"
            : `status is ${health.inference}; connect a model provider before starting a task`,
      });
    }
    if (options.deepChecks || options.testInference) {
      options.onProgress?.("Checking transcription from the server");
      checks.push(
        health.ok && !foreignServer
          ? await checkTranscription(paths)
          : {
              label: "Transcription",
              level: "warn",
              detail: "Not tested; resolve the server health failures first.",
            }
      );
    }
    if (options.testInference) {
      if (
        !health.ok ||
        foreignServer ||
        !project ||
        !runningServices?.has("server") ||
        !runningServices.has("computer")
      ) {
        checks.push({
          level: "warn",
          label: "AI connection",
          detail: "not tested; resolve the server and computer health failures first",
        });
      } else if (health.inference === "missing") {
        checks.push({
          level: "warn",
          label: "AI connection",
          detail: "not tested; no provider is connected. Run openteam setup",
        });
      } else {
        try {
          options.onProgress?.("Testing the saved AI model (up to 40s)");
          const settings = await readRuntimeInferenceSettings(paths);
          const connection = checkInferenceConnection(project, settings);
          checks.push({
            level: connection.ok ? "pass" : "fail",
            label: "AI connection",
            detail: connection.detail,
          });
        } catch (error) {
          checks.push({
            level: "fail",
            label: "AI connection",
            detail: redactSensitiveText(error instanceof Error ? error.message : String(error)),
          });
        }
      }
    }
  }
  return {
    ok: !checks.some((check) => check.level === "fail"),
    installed,
    checks,
    elapsedMs: Date.now() - started,
    commandDirectory,
    platform: process.platform,
  };
};

export const printDoctor = (
  result: DoctorResult,
  options: { compact?: boolean; omitLabels?: readonly string[] } = {}
): void => {
  if (!options.compact) {
    console.log(
      renderDoctor({
        ...result,
        checks: result.checks.filter((check) => !options.omitLabels?.includes(check.label)),
      })
    );
    return;
  }
  console.log(
    renderCompactDoctor({
      ...result,
      checks: result.checks.filter((check) => !options.omitLabels?.includes(check.label)),
    })
  );
};
