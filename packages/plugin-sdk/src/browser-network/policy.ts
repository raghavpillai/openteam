import { lookup } from "node:dns/promises";
import { createConnection, isIP, type Socket } from "node:net";
import { domainToASCII } from "node:url";
import ipaddr from "ipaddr.js";
import type { OpenTarget } from "./protocol";

export class NetworkError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
  }
}
export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    if (ip.range() !== "unicast") return false;
    // Reject translation/transition ranges instead of accepting embedded private IPs.
    if (ip.kind() === "ipv6") {
      const v6 = ip as ipaddr.IPv6;
      if (
        ["64:ff9b::/96", "64:ff9b:1::/48", "2001::/23", "2002::/16", "3fff::/20"].some((cidr) =>
          v6.match(ipaddr.parseCIDR(cidr) as [ipaddr.IPv6, number])
        )
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
export function canonicalHost(host: string): string {
  if (host.includes("%")) throw new NetworkError("destination_blocked");
  if (isIP(host)) return host;
  const name = domainToASCII(host).toLowerCase().replace(/\.$/, "");
  if (
    !name ||
    name.length > 253 ||
    name === "localhost" ||
    /\.(?:localhost|local)$/.test(name) ||
    !name.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
    /^[0-9.]+$/.test(name) ||
    /^(?:0x[\da-f]+|0[0-7]+)$/i.test(name)
  )
    throw new NetworkError("destination_blocked");
  return name;
}
export async function dialTarget(
  target: OpenTarget,
  signal: AbortSignal,
  options: {
    publicOnly?: boolean;
    ports?: readonly number[];
    lookup?: typeof lookup;
    dial?: typeof createConnection;
  } = {}
): Promise<Socket> {
  const timeout = AbortSignal.timeout(15_000);
  const life = AbortSignal.any([signal, timeout]);
  life.throwIfAborted();
  if (options.publicOnly && options.ports && !options.ports.includes(target.port))
    throw new NetworkError("port_blocked");
  const host = options.publicOnly ? canonicalHost(target.host) : target.host;
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    const dnsSignal = AbortSignal.any([life, AbortSignal.timeout(5_000)]);
    addresses = await new Promise((resolve, reject) => {
      const abort = () => reject(new NetworkError("dns_failed"));
      dnsSignal.addEventListener("abort", abort, { once: true });
      (options.lookup ?? lookup)(host, { all: true })
        .then(resolve, () => reject(new NetworkError("dns_failed")))
        .finally(() => dnsSignal.removeEventListener("abort", abort));
      if (dnsSignal.aborted) abort();
    });
  }
  life.throwIfAborted();
  if (!addresses.length) throw new NetworkError("dns_failed");
  if (options.publicOnly && addresses.some((a) => !publicAddress(a.address)))
    throw new NetworkError("destination_blocked");
  // Interleave families while retaining resolver preference within each family.
  // Validate ALL answers above, then dial only pinned IPs: no second lookup.
  const first = addresses[0]!.family;
  const preferred = addresses.filter((a) => a.family === first);
  const alternate = addresses.filter((a) => a.family !== first);
  const candidates: typeof addresses = [];
  while (preferred.length || alternate.length) {
    if (preferred.length) candidates.push(preferred.shift()!);
    if (alternate.length) candidates.push(alternate.shift()!);
  }
  const pending = candidates.slice(0, 8);
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    let lastError: Error | undefined;
    let stagger: ReturnType<typeof setTimeout> | undefined;
    const active = new Map<Socket, () => void>();
    const finish = (socket?: Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(stagger);
      life.removeEventListener("abort", abort);
      for (const [attempt, cleanup] of active) {
        cleanup();
        if (attempt !== socket) attempt.destroy();
      }
      active.clear();
      socket ? resolve(socket) : reject(new NetworkError(life.aborted ? "connect_timeout" : "connect_failed", { cause: lastError }));
    };
    const abort = () => finish();
    const launch = () => {
      clearTimeout(stagger);
      stagger = undefined;
      if (settled) return;
      if (life.aborted) { finish(); return; }
      const address = active.size < 2 ? pending.shift() : undefined;
      if (address) {
        try {
          const socket = (options.dial ?? createConnection)({
            host: address.address, family: address.family, port: target.port,
            allowHalfOpen: true, noDelay: true,
          });
          // Keep a harmless error listener after cancellation/destruction too.
          socket.on("error", () => {});
          const cleanup = () => {
            clearTimeout(timer);
            socket.off("error", failed);
            socket.off("close", closed);
            socket.off("connect", connected);
          };
          const failed = (error?: Error) => {
            if (!active.has(socket)) return;
            if (error instanceof Error) lastError = error;
            cleanup(); active.delete(socket); socket.destroy();
            launch();
          };
          const closed = () => failed();
          const connected = () => {
            if (settled || life.aborted) { socket.destroy(); if (!settled) finish(); return; }
            finish(socket);
          };
          const timer = setTimeout(failed, 3000);
          active.set(socket, cleanup);
          socket.once("error", failed);
          socket.once("close", closed);
          socket.once("connect", connected);
        } catch { launch(); return; }
      }
      if (!active.size && !pending.length) finish();
      else if (active.size < 2 && pending.length) stagger = setTimeout(launch, 250);
    };
    life.addEventListener("abort", abort, { once: true });
    launch();
  });
}
