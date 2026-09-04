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

export const firstUnavailablePort = async (
  host: string,
  ports: readonly number[]
): Promise<number | null> => {
  for (const port of ports) {
    if (!(await portAvailable(host, port))) return port;
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
    if (await portAvailable(host, candidate)) return candidate;
  }
  return preferred;
};
