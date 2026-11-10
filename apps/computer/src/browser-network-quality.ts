import { Agent, request } from "node:https";
import { connect } from "node:tls";
import { randomBytes, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import type { NetworkQuality, NetworkRoute } from "@openteam/plugin-sdk/browser-network/protocol";

const HOST = "speed.cloudflare.com";
const DOWNLOAD_BYTES = 1024 * 1024;
const UPLOAD_BYTES = 256 * 1024;
const FAILURE = "Could not test the active browser connection";

/** Small, owner-triggered HTTP check of the complete browser-to-exit path. Not ICMP. */
export function createQualityProbe(client: {
  route: NetworkRoute | null;
  available(): boolean;
  open(host: string, port: number): Promise<Duplex>;
}) {
  let cached: NetworkQuality | undefined;
  let nextCheck = 0;
  let checkedEpoch: string | undefined;
  let pending: Promise<NetworkQuality> | undefined;
  return (): Promise<NetworkQuality> => {
    const route = client.route;
    if (!route || !client.available()) return Promise.reject(new Error(FAILURE));
    if (pending) return pending;
    if (checkedEpoch === route.epoch && performance.now() < nextCheck)
      return cached?.epoch === route.epoch
        ? Promise.resolve(cached)
        : Promise.reject(new Error(FAILURE));
    const epoch = route.epoch;
    const result = (async () => {
      const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
      const sockets = new Set<Duplex>();
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const valid = () => {
        if (expired || !client.available() || client.route?.epoch !== epoch)
          throw new Error(FAILURE);
      };
      agent.createConnection = (_options, callback) => {
        void client
          .open(HOST, 443)
          .then((raw) => {
            if (expired || client.route?.epoch !== epoch) {
              raw.destroy();
              callback?.(new Error(FAILURE), raw);
              return;
            }
            sockets.add(raw);
            const socket = connect({ socket: raw, servername: HOST });
            socket.once("close", () => sockets.delete(raw));
            callback?.(null, socket);
          })
          .catch(() => callback?.(new Error(FAILURE), undefined as unknown as Duplex));
        return undefined;
      };
      const sample = (bytes: number, upload = false) =>
        new Promise<{ latency: number; duration: number }>((resolve, reject) => {
          valid();
          const started = performance.now();
          const req = request(
            {
              hostname: HOST,
              port: 443,
              agent,
              method: upload ? "POST" : "GET",
              path: upload ? "/__up" : `/__down?bytes=${bytes}&openteam=${randomUUID()}`,
              headers: {
                accept: "*/*",
                "accept-encoding": "identity",
                "cache-control": "no-store",
                ...(upload
                  ? { "content-length": bytes, "content-type": "application/octet-stream" }
                  : {}),
              },
            },
            (response) => {
              const received = performance.now(),
                latency = received - started;
              if (
                response.statusCode !== 200 ||
                (response.headers["content-encoding"] &&
                  response.headers["content-encoding"] !== "identity")
              ) {
                response.destroy();
                reject(new Error(FAILURE));
                return;
              }
              let count = 0;
              response.on("data", (chunk) => {
                count += chunk.length;
                if (count > (upload ? 8192 : bytes)) response.destroy(new Error(FAILURE));
              });
              response.on("error", reject);
              response.on("aborted", () => reject(new Error(FAILURE)));
              response.on("end", () => {
                try {
                  valid();
                  if (!upload && count !== bytes) throw new Error(FAILURE);
                  resolve({
                    latency,
                    duration: Math.max(1, performance.now() - (upload ? started : received)),
                  });
                } catch {
                  reject(new Error(FAILURE));
                }
              });
            }
          );
          req.on("error", reject);
          req.end(upload ? randomBytes(bytes) : undefined);
        });
      try {
        const run = (async (): Promise<NetworkQuality> => {
          await sample(0); // Warm TCP/TLS once, then measure request/response latency.
          const times: number[] = [];
          for (let i = 0; i < 3; i++) times.push((await sample(0)).latency);
          const down = await sample(DOWNLOAD_BYTES);
          const up = await sample(UPLOAD_BYTES, true);
          valid();
          return {
            epoch,
            sourceId: route.mode === "server" ? "server" : route.machineId!,
            checkedAt: new Date().toISOString(),
            latencyMs: Math.round(times.sort((a, b) => a - b)[1]!),
            downloadMbps: Math.round((DOWNLOAD_BYTES * 8) / down.duration / 100) / 10,
            uploadMbps: Math.round((UPLOAD_BYTES * 8) / up.duration / 100) / 10,
            downloadBytes: DOWNLOAD_BYTES,
            uploadBytes: UPLOAD_BYTES,
          };
        })();
        cached = await Promise.race([
          run,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              expired = true;
              agent.destroy();
              for (const socket of sockets) socket.destroy();
              reject(new Error(FAILURE));
            }, 20_000);
          }),
        ]);
        return cached;
      } catch {
        cached = undefined;
        throw new Error(FAILURE);
      } finally {
        checkedEpoch = epoch;
        nextCheck = performance.now() + 60_000;
        expired = true;
        clearTimeout(timer);
        agent.destroy();
        for (const socket of sockets) socket.destroy();
        pending = undefined;
      }
    })();
    pending = result;
    return result;
  };
}
