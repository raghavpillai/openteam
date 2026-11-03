import type { NetworkEgress, NetworkQuality } from "@openteam/contracts/browser-network";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { nodeBinary } from "./node-runtime";

export const browserProxyPort = Number(process.env.OPENTEAM_BROWSER_PROXY_PORT ?? 18791);
if (!Number.isInteger(browserProxyPort) || browserProxyPort < 1024 || browserProxyPort > 65535)
  throw new Error("Invalid browser proxy port");
export const managedBrowserNetworkArguments = (port = browserProxyPort) => [
  `--proxy-server=socks5://127.0.0.1:${port}`,
  "--proxy-bypass-list=<-loopback>",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-extensions",
];

export async function startBrowserNetwork(serverUrl: string, token: string) {
  // Use the image's Node runtime for TCP streams. Bun versions in existing images
  // can discard pending TCP bytes on half-close; browser downloads must not depend on it.
  let child: ChildProcess | undefined,
    stopping = false,
    retry: ReturnType<typeof setTimeout> | undefined;
  type Diagnostic = NetworkEgress | NetworkQuality;
  const probes = new Map<
    string,
    {
      id: string;
      resolve: (result: Diagnostic) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      promise: Promise<Diagnostic>;
    }
  >();
  const failProbe = (kind: string) => {
    const probe = probes.get(kind);
    if (probe) {
      clearTimeout(probe.timer);
      probe.reject(new Error("Could not check browser exit connection"));
      probes.delete(kind);
    }
  };
  const failProbes = () => {
    for (const kind of probes.keys()) failProbe(kind);
  };
  let state = { ready: false, mode: null as string | null, activeConnections: 0 };
  const launch = () =>
    new Promise<void>((resolve, reject) => {
      const adjacent = join(import.meta.dirname, "browser-network-worker.mjs");
      const workerPath = existsSync(adjacent)
        ? adjacent
        : join(import.meta.dirname, "../dist/browser-network-worker.mjs");
      const worker = spawn(nodeBinary(), [workerPath], {
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = worker;
      // Keeping stdin open also ties the worker's lifetime to the gateway, even on SIGKILL.
      worker.stdin!.write(JSON.stringify({ serverUrl, token, port: browserProxyPort }) + "\n");
      let pending = "",
        started = false;
      const timeout = setTimeout(() => {
        worker.kill();
        reject(new Error("Browser network worker failed to start"));
      }, 10_000);
      worker.stdout!.setEncoding("utf8");
      worker.stdout!.on("data", (chunk: string) => {
        pending += chunk;
        if (pending.length > 8192) {
          worker.kill();
          return;
        }
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.started && !started) {
              started = true;
              clearTimeout(timeout);
              resolve();
            }
            for (const [kind, current] of probes) {
              if (value.id !== current.id) continue;
              probes.delete(kind);
              clearTimeout(current.timer);
              if (value.result) current.resolve(value.result);
              else current.reject(new Error("Could not check browser exit connection"));
            }
            if (typeof value.ready === "boolean")
              state = {
                ready: value.ready,
                mode: value.mode ?? null,
                activeConnections: value.activeConnections ?? 0,
              };
          } catch {
            /* Never forward potentially sensitive child output. */
          }
        }
      });
      worker.stderr!.resume();
      worker.on("error", () => {
        clearTimeout(timeout);
        reject(new Error("Could not start browser network worker"));
      });
      worker.once("exit", () => {
        clearTimeout(timeout);
        failProbes();
        state = { ready: false, mode: null, activeConnections: 0 };
        if (!started) reject(new Error("Browser network worker exited before startup"));
        if (!stopping) {
          retry = setTimeout(() => void launch().catch(() => {}), 3000);
          retry.unref();
        }
      });
    });
  await launch();
  const diagnostic = <T extends Diagnostic>(kind: "egress" | "quality"): Promise<T> => {
    const existing = probes.get(kind);
    if (existing) return existing.promise as Promise<T>;
    // Status is an observation, not admission authority: it may lag a handover.
    // The worker checks its live lease before opening any diagnostic connection.
    if (stopping || !child?.stdin?.writable)
      return Promise.reject(new Error("Browser connection unavailable"));
    const id = randomUUID();
    let resolve!: (result: Diagnostic) => void, reject!: (error: Error) => void;
    const promise = new Promise<Diagnostic>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    probes.set(kind, {
      id,
      promise,
      resolve,
      reject,
      timer: setTimeout(() => failProbe(kind), kind === "quality" ? 22_000 : 9000),
    });
    child.stdin.write(JSON.stringify({ op: kind, id }) + "\n", (error) => {
      if (error) failProbe(kind);
    });
    return promise as Promise<T>;
  };
  return {
    status: () => state,
    egress: () => diagnostic<NetworkEgress>("egress"),
    quality: () => diagnostic<NetworkQuality>("quality"),
    close: async () => {
      stopping = true;
      failProbes();
      clearTimeout(retry);
      const worker = child;
      if (!worker || worker.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          worker.kill("SIGKILL");
          resolve();
        }, 2000);
        worker.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        worker.kill("SIGTERM");
      });
    },
  };
}
