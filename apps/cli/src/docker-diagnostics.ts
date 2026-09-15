import type { DoctorCheck } from "./doctor";
import type { RunResult } from "./process";
import { cleanTerminalText } from "./terminal";

const errorCode = (result: RunResult): unknown =>
  result.error && "code" in result.error ? result.error.code : undefined;

/** Keep the actual command failure, including spawn errors, safe for either doctor renderer. */
export const commandDiagnostic = (command: string, result: RunResult): string => {
  const output = result.stderr.trim() || result.stdout.trim();
  const cause =
    errorCode(result) === "ETIMEDOUT"
      ? `Command timed out.${output ? ` ${output}` : ""}`
      : output ||
        result.error?.message ||
        `Exited with code ${result.status}; no error details returned.`;
  const safe = cleanTerminalText(
    cause.replace(/((?:tcp|ssh):\/\/[^\s:/@]+:)[^\s@]+(@)/gi, "$1[REDACTED]$2")
  );
  return `${command}: ${safe.length > 1200 ? `${safe.slice(0, 1200)}…` : safe}`;
};

export const dockerFailureCheck = (
  kind: "cli" | "daemon",
  result: RunResult,
  platform: NodeJS.Platform = process.platform
): DoctorCheck => {
  const command = kind === "cli" ? "docker --version" : "docker info --format '{{.ServerVersion}}'";
  const diagnostic = commandDiagnostic(command, result);
  const raw = `${result.stderr} ${result.stdout} ${result.error?.message ?? ""}`;
  const permission =
    errorCode(result) === "EACCES" || /permission denied|access is denied/i.test(raw);
  if (kind === "cli") {
    const missing = errorCode(result) === "ENOENT" || /not found|not recognized/i.test(raw);
    return {
      level: "fail",
      label: "Docker CLI",
      detail: missing
        ? "The docker command was not found in this terminal."
        : "The docker command could not run.",
      diagnostic,
      action: permission
        ? "Check the Docker executable's permissions or repair its installation, then run docker --version."
        : missing
          ? platform === "linux"
            ? "Install Docker Engine and the Compose plugin (or Docker Desktop), then open a new terminal and run docker --version. If Docker is already installed, check PATH and the executable's permissions."
            : "Install Docker Desktop from https://docs.docker.com/desktop/, then open a new terminal and run docker --version. If Docker is already installed, check that its command is on PATH and check the executable's permissions."
          : "Run docker --version to inspect the error; repair or update the Docker CLI before retrying.",
    };
  }

  let detail = "Docker is installed, but OpenTeam could not connect to its engine.";
  let action =
    platform === "darwin"
      ? "Start your Docker runtime. For Docker Desktop, run open -a Docker and finish any first-run setup. Wait for the engine to be ready, then run docker info. If it still fails, run docker context ls and check DOCKER_HOST and DOCKER_CONTEXT point to the intended engine."
      : platform === "win32"
        ? "Open Docker Desktop, finish any first-run setup, and wait for the Linux container engine to be ready. Run docker info. If it still fails, run docker context ls and check DOCKER_HOST and DOCKER_CONTEXT."
        : "Start your Docker runtime (for a system Docker Engine: sudo systemctl start docker), then run docker info. If it still fails, run docker context ls and check DOCKER_HOST and DOCKER_CONTEXT.";
  if (/permission denied.*(?:publickey|password)|host key verification failed/i.test(raw)) {
    detail = "Docker could not sign in to the remote host over SSH.";
    action =
      "Run docker context ls to check the remote host. Verify SSH access and the host key with that host's administrator, then run docker info.";
  } else if (permission) {
    detail = "Docker denied access to its engine.";
    action =
      "Run docker context ls to verify the selected engine. Check that your user has access to its Docker socket, or ask its administrator to grant access; then run docker info.";
  } else if (/client.*(?:too old|too new)|(?:minimum|maximum) supported API version/i.test(raw)) {
    detail = "The Docker client and engine could not agree on an API version.";
    action =
      "Update the Docker client and engine to compatible versions. Remove any unintended DOCKER_API_VERSION override, then run docker info.";
  } else if (/x509|certificate|TLS handshake/i.test(raw)) {
    detail = "Docker could not establish a trusted connection to its engine.";
    action =
      "Run docker context ls to verify the intended engine, then check its TLS certificates and DOCKER_CERT_PATH. Run docker info after correcting the connection.";
  } else if (/context.*(?:not found|does not exist)|unable to resolve docker endpoint/i.test(raw)) {
    detail = "Docker's selected connection could not be loaded.";
    action =
      "Run docker context ls and select the intended engine with docker context use <name>. Check for unintended DOCKER_HOST or DOCKER_CONTEXT overrides, then run docker info.";
  } else if (/no such host|name or service not known|nodename nor servname|ENOTFOUND/i.test(raw)) {
    detail = "Docker could not resolve its engine's hostname.";
    action =
      "Run docker context ls and check the hostname in DOCKER_HOST. Check your DNS or VPN connection, then run docker info.";
  } else if (
    /https? response to https? client|server gave HTTP response to HTTPS client/i.test(raw)
  ) {
    detail = "The Docker connection's HTTP/TLS settings do not match the engine.";
    action =
      "Check the selected connection with docker context ls. Correct its endpoint and DOCKER_TLS_VERIFY settings to match the engine's configuration, then run docker info.";
  } else if (
    /dockerDesktopLinuxEngine|docker_engine|\/var\/run\/docker\.sock|\/\.docker\/run\/docker\.sock/.test(
      raw
    )
  ) {
    // Desktop's local socket and Windows named pipe also appear inside HTTP error URLs.
  } else if (/(?:tcp|ssh):\/\/|\b(?:Get|Post|Head|Put|Delete)\s+["']?https?:\/\//i.test(raw)) {
    action =
      "Run docker context ls and verify DOCKER_HOST and DOCKER_CONTEXT target the intended engine. Check that engine is running and its host is reachable, then run docker info.";
  }
  if (errorCode(result) === "ETIMEDOUT")
    detail = "Docker did not respond before the engine check timed out.";
  return { level: "fail", label: "Docker daemon", detail, diagnostic, action };
};
