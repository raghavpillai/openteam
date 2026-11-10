import type { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { API_PORT, VIEWER_PORT_END, VIEWER_PORT_START } from "./constants";

export const portAvailable = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.unref();
    (server as unknown as EventEmitter).once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

/**
 * Addresses to probe before Docker publishes a port on `host`. On macOS a loopback bind
 * succeeds while another socket, such as Docker Desktop's, holds the wildcard address, yet
 * Docker still refuses the port; Linux already refuses the loopback bind.
 */
export const probeHosts = (host: string, platform: NodeJS.Platform = process.platform): string[] =>
  Array.from(new Set([host, "127.0.0.1", ...(platform === "linux" ? [] : ["0.0.0.0"])]));

/** First probed address where `port` is taken, or null when Docker can publish it on `host`. */
export const occupiedHost = async (host: string, port: number): Promise<string | null> => {
  for (const candidate of probeHosts(host)) {
    if (!(await portAvailable(candidate, port))) return candidate;
  }
  return null;
};

export const firstUnavailablePort = async (
  host: string,
  ports: readonly number[]
): Promise<number | null> => {
  for (const port of ports) {
    if (await occupiedHost(host, port)) return port;
  }
  return null;
};

export const viewerPorts = (): number[] => {
  const ports: number[] = [];
  for (let port = VIEWER_PORT_START; port <= VIEWER_PORT_END; port += 1) ports.push(port);
  return ports;
};

export const suggestApiPort = async (host: string, preferred = API_PORT): Promise<number> => {
  for (let offset = 0; offset < 100; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65_535) break;
    if (candidate >= VIEWER_PORT_START && candidate <= VIEWER_PORT_END) continue;
    if (!(await occupiedHost(host, candidate))) return candidate;
  }
  return preferred;
};
