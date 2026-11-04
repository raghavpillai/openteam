import { createSocket } from "node:dgram";
import { createServer, type Socket } from "node:net";
import { Agent, request } from "node:https";
import { connect } from "node:tls";
import type { Duplex } from "node:stream";

/** DNS wire messages travel over HTTPS through the same leased exit as TCP.
 * No system lookup or direct fallback is performed, including on timeout. */
export function createDnsExchange(client: { open(host: string, port: number): Promise<Duplex> }) {
  return async (query: Buffer): Promise<Buffer> => {
    if (query.length < 12 || query.length > 4096 || query[2]! & 0x80 || query.readUInt16BE(4) !== 1)
      throw new Error("Invalid DNS query");
    let raw: Duplex | undefined;
    let agent: Agent | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        raw?.destroy(new Error("DNS timeout"));
        agent?.destroy();
        reject(new Error("DNS timeout"));
      }, 5000);
    });
    try {
      const exchange = async () => {
        // Literal bootstrap address avoids resolving the resolver through itself.
        raw = await client.open("1.1.1.1", 443);
        if (expired) {
          raw.destroy();
          throw new Error("DNS timeout");
        }
        agent = new Agent({ keepAlive: false });
        agent.createConnection = () => connect({ socket: raw!, servername: "cloudflare-dns.com" });
        return await new Promise<Buffer>((resolve, reject) => {
          const req = request(
            {
              hostname: "cloudflare-dns.com",
              path: "/dns-query",
              method: "POST",
              agent,
              headers: {
                "content-type": "application/dns-message",
                accept: "application/dns-message",
                "content-length": query.length,
              },
            },
            (response) => {
              if (
                response.statusCode !== 200 ||
                !response.headers["content-type"]?.startsWith("application/dns-message")
              ) {
                response.destroy();
                reject(new Error("DNS unavailable"));
                return;
              }
              const chunks: Buffer[] = [];
              let length = 0;
              response.on("data", (chunk: Buffer) => {
                length += chunk.length;
                if (length > 65535) response.destroy(new Error("DNS response too large"));
                else chunks.push(chunk);
              });
              response.on("error", reject);
              response.on("aborted", () => reject(new Error("DNS interrupted")));
              response.on("end", () => {
                const result = Buffer.concat(chunks);
                if (
                  result.length < 12 ||
                  result.readUInt16BE(0) !== query.readUInt16BE(0) ||
                  !(result[2]! & 0x80)
                )
                  reject(new Error("Invalid DNS response"));
                else resolve(result);
              });
            }
          );
          req.on("error", reject);
          req.end(query);
        });
      };
      return await Promise.race([exchange(), deadline]);
    } finally {
      expired = true;
      clearTimeout(timer);
      agent?.destroy();
      raw?.destroy();
    }
  };
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
