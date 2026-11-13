import { isIP } from "node:net";

const events = [
  "route_changed",
  "route_fenced",
  "transport_closed",
  "transport_error",
  "lease_expired",
  "proxy_capacity",
  "proxy_dial_failed",
  "proxy_socket_error",
  "worker_started",
  "worker_exited",
  "tunnel_exited",
] as const;
const reasons = [
  "source_changed",
  "route_invalidated",
  "transport_closed",
  "stopped",
  "lease_expired",
  "apply_timeout",
  "validation_failed",
  "control_failed",
  "backpressure",
  "peer_replaced",
  "permission_revoked",
  "protocol_error",
  "queue_capacity",
  "peer_closed",
] as const;
const codes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNABORTED",
  "EMFILE",
  "ENFILE",
  "ENOBUFS",
  "EACCES",
  "EPERM",
  "device_unavailable",
  "capacity",
  "capacity_exceeded",
  "request_cancelled",
  "dns_failed",
  "connect_failed",
  "connect_timeout",
  "destination_blocked",
  "port_blocked",
  "not_authorized",
  "stream_closed",
]);

export type NetworkDiagnostic = {
  event: (typeof events)[number];
  reason?: (typeof reasons)[number];
  code?: string;
  side?: "client" | "upstream";
  mode?: "server" | "device";
  previousMode?: "server" | "device";
  epoch?: string;
  previousEpoch?: string;
  sourceId?: string;
  previousSourceId?: string;
  address?: string;
  port?: number;
  connectionId?: number;
  activeConnections?: number;
  limit?: number;
  closeCode?: number;
  suppressed?: number;
};
export type NetworkDiagnosticSink = (event: NetworkDiagnostic) => void;

/** Preserve only recognized error codes, never messages, URLs, headers or close reasons. */
export function networkErrorCode(error: unknown): string {
  let code = "unknown";
  for (let depth = 0; depth < 3 && error && typeof error === "object"; depth++) {
    const value = error as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string" && codes.has(value.code)) code = value.code;
    if (value.cause) {
      error = value.cause;
      continue;
    }
    break;
  }
  return code;
}

/** This is also the trust boundary for private worker output. Copy an explicit field allowlist. */
export function sanitizeNetworkDiagnostic(input: unknown): NetworkDiagnostic | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const event =
    typeof value.event === "string" ? value.event.replace(/^computer_network\./, "") : value.event;
  if (!(events as readonly unknown[]).includes(event)) return null;
  const result: NetworkDiagnostic = { event: event as NetworkDiagnostic["event"] };
  if ((reasons as readonly unknown[]).includes(value.reason))
    result.reason = value.reason as NetworkDiagnostic["reason"];
  if (typeof value.code === "string") result.code = codes.has(value.code) ? value.code : "unknown";
  if (value.side === "client" || value.side === "upstream") result.side = value.side;
  for (const field of ["mode", "previousMode"] as const)
    if (value[field] === "server" || value[field] === "device") result[field] = value[field];
  for (const field of ["epoch", "previousEpoch"] as const)
    if (
      typeof value[field] === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value[field])
    )
      result[field] = value[field];
  for (const field of ["sourceId", "previousSourceId"] as const)
    if (
      value[field] === "server" ||
      (typeof value[field] === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value[field]))
    )
      result[field] = value[field];
  if (typeof value.address === "string" && !value.address.includes("%") && isIP(value.address))
    result.address = value.address;
  for (const field of [
    "port",
    "connectionId",
    "activeConnections",
    "limit",
    "closeCode",
    "suppressed",
  ] as const) {
    const number = value[field];
    if (
      typeof number === "number" &&
      Number.isSafeInteger(number) &&
      number >= 0 &&
      number <= 0xffffffff
    )
      result[field] = number;
  }
  return result;
}

/** Bound each process's output during a connection storm. Report the number suppressed. */
export function createNetworkDiagnostics(
  component: "server" | "computer" | "desktop",
  write: (line: string) => void = (line) => console.warn(line),
  now = () => performance.now()
): NetworkDiagnosticSink {
  // Reserve a separate budget for route/control events so a failed-dial storm cannot hide them.
  const budget = () => ({ window: now(), emitted: 0, suppressed: 0 });
  const control = budget(),
    connections = budget();
  return (input) => {
    try {
      const value = sanitizeNetworkDiagnostic(input);
      if (!value) return;
      const bucket = value.event.startsWith("proxy_") ? connections : control;
      if (now() - bucket.window >= 1000) {
        bucket.window = now();
        bucket.emitted = 0;
      }
      if (bucket.emitted++ >= 20) {
        bucket.suppressed++;
        return;
      }
      write(
        JSON.stringify({
          event: `computer_network.${value.event}`,
          component,
          timestamp: new Date().toISOString(),
          ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "event")),
          ...(bucket.suppressed || value.suppressed
            ? { suppressed: bucket.suppressed + (value.suppressed ?? 0) }
            : {}),
        })
      );
      bucket.suppressed = 0;
    } catch {
      /* Observability must never break networking. */
    }
  };
}
