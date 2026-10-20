import { CliError } from "./errors";
import type { CommandRunner } from "./process";

export interface TailscaleHttps {
  host: string;
  addresses: string[];
  port?: string;
}
export interface TailscaleInspection {
  node: TailscaleHttps | null;
  issue: string | null;
}
export const tailscaleHttpsHost = ({ host, port }: TailscaleHttps): string =>
  port && port !== "443" ? `${host}:${port}` : host;

export function validateTailscalePort(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new CliError("Tailscale HTTPS port must be a whole number from 1 to 65535.");
  return String(Number(value));
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

function execute(runner: CommandRunner, args: string[]): string {
  let result;
  try {
    result = runner.run("tailscale", args, { timeoutMs: args.includes("--bg") ? 10_000 : 3_000 });
  } catch {
    throw new CliError(
      "Tailscale CLI is unavailable. Install Tailscale on the server host and put tailscale on PATH."
    );
  }
  if (result.status === 0) return result.stdout;
  const detail = `${result.error?.message ?? ""} ${result.stderr} ${result.stdout}`;
  // Only return known diagnostics, never arbitrary CLI output (which may contain secrets).
  const enableLink = detail.match(/https:\/\/login\.tailscale\.com\/f\/serve\b[\w/?=&%.-]*/)?.[0];
  if (enableLink || /HTTPS.*(?:not enabled|disabled)|Serve is not enabled/i.test(detail))
    throw new CliError(
      `Enable HTTPS certificates for your tailnet, then retry. ${enableLink ?? "https://login.tailscale.com/admin/dns"}`
    );
  if (/permission|access denied|must be root|operator/i.test(detail))
    throw new CliError(
      "Tailscale denied permission to manage Serve. Configure a Tailscale operator for your account on the server host, then retry."
    );
  if (/ENOENT|not found/i.test(detail))
    throw new CliError(
      "Tailscale CLI is unavailable. Install Tailscale on the server host and put tailscale on PATH."
    );
  if (/login|logged out/i.test(detail))
    throw new CliError("Tailscale is logged out. Run tailscale up on the server host, then retry.");
  if (/timed out|ETIMEDOUT/i.test(detail))
    throw new CliError(
      "Tailscale timed out. Check that its daemon is running and retry; inspect tailscale serve status before changing routes."
    );
  throw new CliError(
    "Tailscale could not complete the command. Check tailscale status and tailscale serve status on the server host; ensure the daemon is running."
  );
}

export function readTailscaleServe(runner: CommandRunner): Json {
  return read(runner, ["serve", "status", "--json"]);
}
function read(runner: CommandRunner, args: string[]): Json {
  const raw = execute(runner, args);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return object(parsed);
  } catch {
    throw new CliError(
      "Tailscale returned invalid status. Update Tailscale and check tailscale status --json on the server host."
    );
  }
}

// Never replace another listener, enable Funnel, or change a foreground session.
export function tailscaleRoute(
  config: Json,
  host: string,
  port: string,
  httpsPort = "443"
): "free" | "matching" | "occupied" {
  if (Object.keys(object(config.Foreground)).length) return "occupied";
  if (
    Object.entries(object(config.AllowFunnel)).some(
      ([key, enabled]) => key.endsWith(`:${httpsPort}`) && enabled
    )
  )
    return "occupied";
  const tcp = object(config.TCP)[httpsPort];
  const webs = Object.entries(object(config.Web)).filter(([key]) => key.endsWith(`:${httpsPort}`));
  if (!tcp && !webs.length) return "free";
  if (
    object(tcp).HTTPS !== true ||
    Object.keys(object(tcp)).some((key) => key !== "HTTPS") ||
    webs.length !== 1 ||
    webs[0]![0] !== `${host}:${httpsPort}`
  )
    return "occupied";
  const handlers = object(object(webs[0]![1]).Handlers);
  if (Object.keys(handlers).length !== 1 || !handlers["/"]) return "occupied";
  const proxy = object(handlers["/"]).Proxy;
  return typeof proxy === "string" &&
    [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(proxy)
    ? "matching"
    : "occupied";
}

export function inspectTailscale(runner: CommandRunner): TailscaleInspection {
  try {
    const status = read(runner, ["status", "--json"]);
    if (status.BackendState !== "Running")
      return {
        node: null,
        issue:
          status.BackendState === "NeedsLogin"
            ? "Tailscale is logged out. Run tailscale up on the server host, then retry."
            : "Tailscale is stopped. Start Tailscale on the server host, then retry.",
      };
    const host = String(object(status.Self).DNSName ?? "")
      .replace(/\.$/, "")
      .toLowerCase();
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(host))
      return {
        node: null,
        issue:
          "No Tailscale MagicDNS hostname was found. Enable MagicDNS at https://login.tailscale.com/admin/dns and retry.",
      };
    const addresses = object(status.Self).TailscaleIPs;
    const node = {
      host,
      addresses: Array.isArray(addresses)
        ? addresses.filter((x): x is string => typeof x === "string")
        : [],
    };
    return {
      node,
      issue:
        Array.isArray(status.CertDomains) && status.CertDomains.includes(host)
          ? null
          : "Enable HTTPS certificates for your tailnet at https://login.tailscale.com/admin/dns, then retry. Both devices must be connected to Tailscale.",
    };
  } catch (error) {
    return {
      node: null,
      issue: error instanceof Error ? error.message : "Tailscale could not be inspected.",
    };
  }
}

export function requireTailscale(runner: CommandRunner, port = "443"): TailscaleHttps {
  const inspected = inspectTailscale(runner);
  if (inspected.issue || !inspected.node)
    throw new CliError(inspected.issue || "Tailscale is unavailable.");
  return { ...inspected.node, port: validateTailscalePort(port) };
}

/** Recommend a free default or reuse an existing private route, including custom ports. */
export function detectTailscaleHttps(runner: CommandRunner, port: string): TailscaleHttps | null {
  const { node, issue } = inspectTailscale(runner);
  if (!node || issue) return null;
  try {
    const config = readTailscaleServe(runner);
    const existingPort = Object.keys(object(config.TCP))
      .filter((value) => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535)
      .sort((a, b) => (a === "443" ? -1 : b === "443" ? 1 : Number(a) - Number(b)))
      .find((value) => tailscaleRoute(config, node.host, port, value) === "matching");
    if (!existingPort && tailscaleRoute(config, node.host, port) === "occupied") return null;
    return { ...node, ...(existingPort && existingPort !== "443" ? { port: existingPort } : {}) };
  } catch {
    return null;
  }
}

export function assertTailscaleRouteAvailable(
  runner: CommandRunner,
  node: TailscaleHttps,
  backendPort: string
): void {
  if (tailscaleRoute(readTailscaleServe(runner), node.host, backendPort, node.port) === "occupied")
    throw new CliError(
      `Tailscale Serve port ${node.port || "443"} has an incompatible route or a foreground session is active. Inspect tailscale serve status, then choose another HTTPS port. Existing routes and Funnel settings were preserved.`
    );
}

/** Returns true only when this call created the route. */
export function configureTailscaleRoute(
  runner: CommandRunner,
  node: TailscaleHttps,
  backendPort: string
): boolean {
  const httpsPort = validateTailscalePort(node.port || "443");
  validateTailscalePort(backendPort);
  const route = tailscaleRoute(readTailscaleServe(runner), node.host, backendPort, httpsPort);
  if (route === "matching") return false;
  if (route !== "free")
    throw new CliError(
      `Tailscale Serve port ${httpsPort} is occupied or a foreground session is active. Existing routes were preserved. Choose another HTTPS port.`
    );
  execute(runner, ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${backendPort}`]);
  if (tailscaleRoute(readTailscaleServe(runner), node.host, backendPort, httpsPort) !== "matching")
    throw new CliError(
      "Tailscale Serve did not install the expected private route. Inspect tailscale serve status and retry."
    );
  return true;
}

export function removeTailscaleRoute(
  runner: CommandRunner,
  node: TailscaleHttps,
  backendPort: string
): void {
  const port = validateTailscalePort(node.port || "443");
  const route = tailscaleRoute(readTailscaleServe(runner), node.host, backendPort, port);
  if (route === "free") return;
  if (route !== "matching")
    throw new CliError(
      `Tailscale Serve port ${port} changed since OpenTeam created it. It was preserved; inspect tailscale serve status before removing it manually.`
    );
  execute(runner, ["serve", `--https=${port}`, "off"]);
  if (tailscaleRoute(readTailscaleServe(runner), node.host, backendPort, port) !== "free")
    throw new CliError(
      `Tailscale Serve port ${port} could not be removed. Inspect tailscale serve status.`
    );
}
