import { connect } from "node:tls";
import { execFile } from "node:child_process";
import type { Duplex } from "node:stream";
import type {
  NetworkConnectivity,
  NetworkFamilyHealth,
} from "@openteam/plugin-sdk/browser-network/protocol";

type Family = "ipv4" | "ipv6";
type Route = { epoch: string; sourceId: string };
type Families = Record<Family, boolean>;
// Independent providers, pinned public addresses. DNS itself must not depend
// on a family that is still being checked. TLS certificates remain verified.
const targets = {
  ipv4: [
    ["1.1.1.1", "cloudflare-dns.com"],
    ["8.8.8.8", "dns.google"],
  ],
  ipv6: [
    ["2606:4700:4700::1111", "cloudflare-dns.com"],
    ["2001:4860:4860::8888", "dns.google"],
  ],
} as const;

export async function probeNetworkFamily(
  open: (host: string, port: number, signal: AbortSignal) => Promise<Duplex>,
  family: Family,
  signal: AbortSignal
): Promise<NetworkFamilyHealth> {
  const life = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
  let reachedTls = false;
  const attempts = targets[family].map(async ([host, servername]) => {
    const raw = await open(host, 443, life);
    if (life.aborted) {
      raw.destroy();
      life.throwIfAborted();
    }
    reachedTls = true;
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ socket: raw, servername });
      const abort = () => {
        socket.destroy();
        reject(new Error("Probe cancelled"));
      };
      const done = (error?: Error) => {
        life.removeEventListener("abort", abort);
        socket.destroy();
        error ? reject(error) : resolve();
      };
      socket.once("secureConnect", () => done());
      socket.once("error", done);
      life.addEventListener("abort", abort, { once: true });
      if (life.aborted) abort();
    });
  });
  // Settle both attempts so no probe socket outlives its measurement.
  const results = await Promise.allSettled(attempts);
  signal.throwIfAborted();
  return results.some((result) => result.status === "fulfilled")
    ? { state: "working" }
    : { state: "unavailable", reason: reachedTls ? "tls_failed" : "connect_failed" };
}

export function applyNetworkFamilies(families: Families, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "/usr/lib/openteam/bin/openteam-computer-network.py",
        "--families",
        JSON.stringify(families),
      ],
      { timeout: 3000, signal, env: { PATH: process.env.PATH } },
      (error) => (error ? reject(new Error("Could not apply network capabilities")) : resolve())
    );
  });
}

/** Serializes kernel changes and cancels old measurements on lease changes.
 * Probes have no application payload and never replay user requests. */
export function startNetworkConnectivity(options: {
  route: () => Route | null;
  probe: (family: Family, signal: AbortSignal) => Promise<NetworkFamilyHealth>;
  verify?: (family: Family, signal: AbortSignal) => Promise<NetworkFamilyHealth>;
  apply: (families: Families, signal: AbortSignal) => Promise<void>;
  changed: () => void;
  failed: () => void;
  intervalMs?: number;
  retryMs?: number;
}) {
  let value: NetworkConnectivity | undefined;
  let controller = new AbortController();
  let queue = Promise.resolve();
  let stopped = false,
    measuring = false,
    nextCheck = 0;
  let enabled: Families = { ipv4: false, ipv6: false };
  let failures: Record<Family, number> = { ipv4: 0, ipv6: 0 };
  let key: string | undefined;
  const enqueue = (task: () => Promise<void>, signal: AbortSignal) => {
    queue = queue.then(task).catch(() => {
      if (!stopped && !signal.aborted) options.failed();
    });
  };
  const measure = async (route: Route, signal: AbortSignal) => {
    if (signal.aborted || stopped) return;
    measuring = true;
    try {
      const [ipv4, ipv6] = await Promise.all([
        options.probe("ipv4", signal),
        options.probe("ipv6", signal),
      ]);
      signal.throwIfAborted();
      const results = { ipv4, ipv6 };
      for (const family of ["ipv4", "ipv6"] as const) {
        failures[family] = results[family].state === "working" ? 0 : failures[family] + 1;
        if (results[family].state === "working") enabled[family] = true;
        else if (enabled[family] && failures[family] < 2) results[family] = { state: "checking" };
        else enabled[family] = false;
      }
      await options.apply({ ...enabled }, signal);
      signal.throwIfAborted();
      if (options.verify) {
        await Promise.all(
          (["ipv4", "ipv6"] as const).map(async (family) => {
            if (results[family].state !== "working") return;
            const result = await options.verify!(family, signal).catch((): NetworkFamilyHealth => {
              signal.throwIfAborted();
              return { state: "unavailable", reason: "path_failed" };
            });
            signal.throwIfAborted();
            if (result.state !== "working") {
              enabled[family] = false;
              results[family] = { state: "unavailable", reason: "path_failed" };
            }
          })
        );
        await options.apply({ ...enabled }, signal);
        signal.throwIfAborted();
      }
      value = { ...route, ...results, checkedAt: new Date().toISOString() };
      nextCheck =
        performance.now() +
        (Object.values(results).some((v) => v.state === "checking")
          ? (options.retryMs ?? 10_000)
          : (options.intervalMs ?? 60_000));
      options.changed();
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      measuring = false;
    }
  };
  const sync = () => {
    if (stopped) return;
    const route = options.route();
    const nextKey = route ? JSON.stringify([route.epoch, route.sourceId]) : undefined;
    if (nextKey !== key) {
      key = nextKey;
      nextCheck = Infinity;
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      enabled = { ipv4: false, ipv6: false };
      failures = { ipv4: 0, ipv6: 0 };
      value = route
        ? { ...route, checkedAt: null, ipv4: { state: "checking" }, ipv6: { state: "checking" } }
        : undefined;
      options.changed();
      enqueue(async () => {
        if (signal.aborted) return;
        await options.apply({ ipv4: false, ipv6: false }, signal);
        if (route) await measure(route, signal);
      }, signal);
    } else if (route && !measuring && performance.now() >= nextCheck) {
      // Reserve synchronously: lease callbacks can run before the queue starts.
      nextCheck = Infinity;
      const signal = controller.signal;
      enqueue(() => measure(route, signal), signal);
    }
  };
  // Clear any routes left by a worker crash before accepting a new lease.
  const initialSignal = controller.signal;
  enqueue(async () => {
    if (!initialSignal.aborted) await options.apply({ ipv4: false, ipv6: false }, initialSignal);
  }, initialSignal);
  const timer = setInterval(sync, 1000);
  timer.unref();
  return {
    sync,
    status: () => value,
    async close() {
      stopped = true;
      clearInterval(timer);
      controller.abort();
      await queue;
      await options.apply({ ipv4: false, ipv6: false }, AbortSignal.timeout(3000));
    },
  };
}
