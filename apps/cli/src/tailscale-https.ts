import type { CommandRunner } from "./process";

export interface TailscaleHttps {
  host: string;
  addresses: string[];
  port?: string;
}

export const tailscaleHttpsHost = ({ host, port }: TailscaleHttps): string =>
  port && port !== "443" ? `${host}:${port}` : host;

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

function read(runner: CommandRunner, args: string[]): Json | null {
  try {
    const result = runner.run("tailscale", args, { timeoutMs: 3_000 });
    if (result.status !== 0) return null;
    const parsed: unknown = JSON.parse(result.stdout);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? object(parsed) : null;
  } catch {
    return null;
  }
}

// Never replace someone else's listener or a foreground Serve session.
function route(config: Json, host: string, port: string, httpsPort = "443"): "free" | "matching" | "occupied" {
  if (Object.keys(object(config.Foreground)).length) return "occupied";
  if (object(config.AllowFunnel)[`${host}:${httpsPort}`]) return "occupied";
  const tcp = object(config.TCP)[httpsPort];
  const webs = Object.entries(object(config.Web)).filter(([key]) => key.endsWith(`:${httpsPort}`));
  if (!tcp && !webs.length) return "free";
  if (!object(tcp).HTTPS || webs.length !== 1 || webs[0]![0] !== `${host}:${httpsPort}`) return "occupied";
  const handlers = object(object(webs[0]![1]).Handlers);
  if (Object.keys(handlers).length !== 1 || !handlers["/"]) return "occupied";
  const proxy = object(handlers["/"]).Proxy;
  return typeof proxy === "string" &&
    [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(proxy)
    ? "matching"
    : "occupied";
}

/** Only propose HTTPS when this node already has certificate support enabled. */
export function detectTailscaleHttps(runner: CommandRunner, port: string): TailscaleHttps | null {
  const status = read(runner, ["status", "--json"]);
  if (status?.BackendState !== "Running") return null;
  const host = String(object(status.Self).DNSName ?? "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(host)) return null;
  if (!Array.isArray(status.CertDomains) || !status.CertDomains.includes(host)) return null;
  const config = read(runner, ["serve", "status", "--json"]);
  if (!config) return null;
  // Reuse an existing private route even when 443 belongs to another application.
  const existingPort = Object.keys(object(config.TCP))
    .filter(value => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535)
    .sort((a, b) => (a === "443" ? -1 : b === "443" ? 1 : Number(a) - Number(b)))
    .find(value => route(config, host, port, value) === "matching");
  if (!existingPort && route(config, host, port) === "occupied") return null;
  const addresses = object(status.Self).TailscaleIPs;
  return {
    host,
    addresses: Array.isArray(addresses)
      ? addresses.filter((x): x is string => typeof x === "string")
      : [],
    ...(existingPort && existingPort !== "443" ? { port: existingPort } : {}),
  };
}

/** Recheck immediately before writing, then verify the persistent private HTTPS route. */
export function ensureTailscaleHttps(
  runner: CommandRunner,
  candidate: TailscaleHttps,
  port: string
): boolean {
  const config = read(runner, ["serve", "status", "--json"]);
  if (!config) return false;
  const existing = route(config, candidate.host, port, candidate.port);
  if (existing === "matching") return true;
  if (existing === "occupied") return false;
  if (candidate.port && candidate.port !== "443") return false;
  try {
    const result = runner.run(
      "tailscale",
      ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`],
      { timeoutMs: 10_000 }
    );
    if (result.status !== 0) return false;
    const updated = read(runner, ["serve", "status", "--json"]);
    return Boolean(updated && route(updated, candidate.host, port) === "matching");
  } catch {
    return false;
  }
}
