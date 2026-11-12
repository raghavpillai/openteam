import { createSocket } from "node:dgram";
import { createServer, type Socket } from "node:net";
import { Agent, request } from "node:https";
import { connect } from "node:tls";
import type { Duplex } from "node:stream";

/** DNS wire messages travel over HTTPS through the same leased exit as TCP.
 * No system lookup or direct fallback is performed, including on timeout. */
export function createDnsExchange(
  client: { open(host: string, port: number, signal?: AbortSignal): Promise<Duplex> },
  options: { routeKey?: () => string | null; timeoutMs?: number; preferIPv6?: () => boolean } = {}
) {
  type Job = {
    query: Buffer;
    resolve: (result: Buffer) => void;
    reject: (error: Error) => void;
    controller: AbortController;
    deadline: number;
    timer?: ReturnType<typeof setTimeout>;
    request?: ReturnType<typeof request>;
    slot?: Slot;
    done: boolean;
  };
  type Slot = { agent: Agent; job?: Job; raw?: Duplex; socket?: Duplex };
  type Pool = { key: string; slots: Slot[]; jobs: Set<Job>; queue: Job[]; closed: boolean };
  let pool: Pool | undefined,
    closed = false;
  const bootstrapAddress = () => options.preferIPv6?.() ? "2606:4700:4700::1111" : "1.1.1.1";
  const routeKey = () => {
    const key = options.routeKey ? options.routeKey() : "selected-route";
    return key ? `${key}:${bootstrapAddress()}` : null;
  };
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error("Invalid DNS deadline");

  const agentFor = (owner: Pool, slot: Slot) => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 10_000 });
    agent.createConnection = () => {
      // Always return a prepared TLS socket synchronously. An undefined return
      // can make alternate HTTP runtimes open their own direct connection.
      const raw = slot.raw;
      slot.raw = undefined;
      if (!raw || owner.closed || slot.job?.done || routeKey() !== owner.key) {
        raw?.destroy();
        throw new Error("DNS connection unavailable");
      }
      const socket = connect({ socket: raw, servername: "cloudflare-dns.com" });
      slot.socket = socket;
      return socket;
    };
    return agent;
  };
  const finish = (owner: Pool, job: Job, error?: Error, result?: Buffer) => {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    owner.jobs.delete(job);
    const queued = owner.queue.indexOf(job);
    if (queued >= 0) owner.queue.splice(queued, 1);
    if (error) {
      job.controller.abort();
      job.request?.destroy(error);
      job.slot?.agent.destroy();
      job.slot?.raw?.destroy();
      job.slot?.socket?.destroy();
    }
    if (job.slot) {
      const slot = job.slot;
      slot.job = undefined;
      if (error && !owner.closed) slot.agent = agentFor(owner, slot);
    }
    error ? job.reject(error) : job.resolve(result!);
    pump(owner);
  };
  const dispose = (owner: Pool) => {
    owner.closed = true;
    for (const slot of owner.slots) {
      slot.agent.destroy();
      slot.raw?.destroy();
      slot.socket?.destroy();
    }
    for (const job of [...owner.jobs]) finish(owner, job, new Error("DNS route changed"));
  };
  const syncRoute = () => {
    if (pool && pool.key !== routeKey()) {
      dispose(pool);
      pool = undefined;
    }
  };
  const pump = (owner: Pool) => {
    if (owner.closed) return;
    for (const slot of owner.slots) {
      if (slot.job || !owner.queue.length) continue;
      const job = owner.queue.shift()!;
      if (performance.now() >= job.deadline) {
        finish(owner, job, new Error("DNS timeout"));
        continue;
      }
      slot.job = job;
      job.slot = slot;
      if (routeKey() !== owner.key) {
        dispose(owner);
        return;
      }
      void (async () => {
        if (!slot.socket || slot.socket.destroyed) {
          const raw = await client.open(bootstrapAddress(), 443, job.controller.signal);
          if (job.done || owner.closed || routeKey() !== owner.key) {
            raw.destroy();
            if (!job.done) dispose(owner);
            return;
          }
          if (performance.now() >= job.deadline) {
            raw.destroy();
            finish(owner, job, new Error("DNS timeout"));
            return;
          }
          slot.raw = raw;
        }
        const req = request(
          {
            hostname: "cloudflare-dns.com",
            path: "/dns-query",
            method: "POST",
            agent: slot.agent,
            headers: {
              "content-type": "application/dns-message",
              accept: "application/dns-message",
              "content-length": job.query.length,
            },
          },
          (response) => {
            if (job.done) {
              response.destroy();
              return;
            }
            if (
              response.statusCode !== 200 ||
              !response.headers["content-type"]?.startsWith("application/dns-message") ||
              (response.headers["content-encoding"] &&
                response.headers["content-encoding"] !== "identity")
            ) {
              response.destroy();
              finish(owner, job, new Error("DNS unavailable"));
              return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            response.on("data", (chunk: Buffer) => {
              length += chunk.length;
              if (length > 65535) response.destroy(new Error("DNS response too large"));
              else chunks.push(chunk);
            });
            response.on("error", (error) => finish(owner, job, error));
            response.on("aborted", () => finish(owner, job, new Error("DNS interrupted")));
            response.on("end", () => {
              if (job.done) return;
              if (performance.now() >= job.deadline) {
                finish(owner, job, new Error("DNS timeout"));
                return;
              }
              const result = Buffer.concat(chunks);
              if (
                result.length < 12 ||
                result.readUInt16BE(0) !== job.query.readUInt16BE(0) ||
                !(result[2]! & 0x80)
              )
                finish(owner, job, new Error("Invalid DNS response"));
              else if (routeKey() !== owner.key) {
                dispose(owner);
              } else {
                if (response.headers.connection?.toLowerCase() === "close") {
                  slot.agent.destroy();
                  slot.socket?.destroy();
                  slot.socket = undefined;
                  slot.agent = agentFor(owner, slot);
                }
                finish(owner, job, undefined, result);
              }
            });
          }
        );
        job.request = req;
        req.on("error", (error) => finish(owner, job, error));
        req.end(job.query);
      })().catch((error) =>
        finish(owner, job, error instanceof Error ? error : new Error("DNS unavailable"))
      );
    }
  };
  const exchange = (query: Buffer): Promise<Buffer> => {
    if (query.length < 12 || query.length > 4096 || query[2]! & 0x80 || query.readUInt16BE(4) !== 1)
      return Promise.reject(new Error("Invalid DNS query"));
    syncRoute();
    const key = routeKey();
    if (closed || !key) return Promise.reject(new Error("DNS route unavailable"));
    if (!pool) {
      pool = { key, slots: [], jobs: new Set(), queue: [], closed: false };
      for (let i = 0; i < 2; i++) {
        const slot = {} as Slot;
        slot.agent = agentFor(pool, slot);
        pool.slots.push(slot);
      }
    }
    const owner = pool;
    if (owner.jobs.size >= 64) return Promise.reject(new Error("DNS capacity exceeded"));
    return new Promise((resolve, reject) => {
      const job: Job = {
        query: Buffer.from(query),
        resolve,
        reject,
        controller: new AbortController(),
        deadline: performance.now() + timeoutMs,
        done: false,
      };
      owner.jobs.add(job);
      owner.queue.push(job);
      // Includes queueing and tunnel establishment; a timed-out dial is cancelled.
      job.timer = setTimeout(() => finish(owner, job, new Error("DNS timeout")), timeoutMs);
      pump(owner);
    });
  };
  exchange.syncRoute = syncRoute;
  exchange.close = () => {
    closed = true;
    if (pool) dispose(pool);
    pool = undefined;
  };
  return exchange;
}

export function dnsFailure(query: Buffer): Buffer {
  const reply = Buffer.alloc(12);
  query.copy(reply, 0, 0, Math.min(query.length, 2));
  reply[2] = 0x80 | (query.length > 2 ? query[2]! & 1 : 0);
  reply[3] = 0x82; // Recursion available; SERVFAIL, never an alternate resolver.
  return reply;
}

/** Both UDP and length-prefixed TCP DNS; bounded admission and idle lifetimes. */
export async function startComputerDns(
  exchange: (query: Buffer) => Promise<Buffer>,
  port = 5353,
  hosts: string[] = ["127.0.0.1", "::1"]
) {
  let active = 0,
    closing = false;
  let boundPort = port;
  const sockets = new Set<Socket>();
  const udp: ReturnType<typeof createSocket>[] = [];
  const tcp: ReturnType<typeof createServer>[] = [];
  const resolve = async (query: Buffer) => {
    if (closing || active >= 64 || query.length > 4096) return dnsFailure(query);
    active++;
    try {
      return await exchange(query);
    } catch {
      return dnsFailure(query);
    } finally {
      active--;
    }
  };
  try {
    for (const host of hosts) {
      const datagram = createSocket(host.includes(":") ? "udp6" : "udp4");
      udp.push(datagram);
      datagram.on("error", () => {});
      datagram.on("message", (query, peer) => {
        void resolve(query).then((response) => {
          if (!closing) datagram.send(response, peer.port, peer.address, () => {});
        });
      });
      await new Promise<void>((yes, no) => {
        datagram.once("error", no);
        datagram.bind(boundPort, host, () => {
          datagram.off("error", no);
          boundPort = datagram.address().port;
          yes();
        });
      });
      const server = createServer((socket) => {
        if (sockets.size >= 64) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        socket.setTimeout(10_000, () => socket.destroy());
        let buffered = Buffer.alloc(0),
          pending = 0;
        socket.on("data", (chunk) => {
          buffered = Buffer.concat([buffered, chunk]);
          if (buffered.length > 8192) {
            socket.destroy();
            return;
          }
          while (buffered.length >= 2) {
            const size = buffered.readUInt16BE(0);
            if (size < 12 || size > 4096 || pending >= 4) {
              socket.destroy();
              return;
            }
            if (buffered.length < size + 2) return;
            const query = Buffer.from(buffered.subarray(2, size + 2));
            buffered = buffered.subarray(size + 2);
            pending++;
            void resolve(query).then((response) => {
              pending--;
              if (socket.destroyed) return;
              const prefix = Buffer.alloc(2);
              prefix.writeUInt16BE(response.length);
              socket.write(Buffer.concat([prefix, response]));
            });
          }
        });
      });
      tcp.push(server);
      await new Promise<void>((yes, no) => {
        server.once("error", no);
        server.listen({ host, port: boundPort, ipv6Only: true }, () => {
          server.off("error", no);
          yes();
        });
      });
    }
  } catch (error) {
    closing = true;
    for (const socket of udp) {
      try {
        socket.close();
      } catch {}
    }
    for (const server of tcp) server.close();
    for (const socket of sockets) socket.destroy();
    throw error;
  }
  return {
    port: boundPort,
    close() {
      closing = true;
      for (const socket of udp) socket.close();
      for (const server of tcp) server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
