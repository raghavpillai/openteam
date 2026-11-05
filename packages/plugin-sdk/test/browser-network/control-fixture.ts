import { WebSocketServer } from "ws";
import { NetworkMux } from "../../src/browser-network/mux";
import { NETWORK_PROTOCOL } from "../../src/browser-network/protocol";
import type { Duplex } from "node:stream";

/** Isolated integration server, with no application enrollment or credentials. */
export function startControlFixture(
  port: number,
  open: (host: string, port: number) => Promise<Duplex>
) {
  const server = new WebSocketServer({
    port,
    host: "0.0.0.0",
    handleProtocols: () => NETWORK_PROTOCOL,
  });
  server.on("connection", (socket) => {
    const mux = new NetworkMux(
      {
        send: (bytes) => socket.send(bytes),
        close: () => socket.terminate(),
        get bufferedAmount() {
          return socket.bufferedAmount;
        },
      },
      {
        control: (message) => {
          if (message.op === "lease")
            mux.control({
              op: "lease",
              nonce: message.nonce,
              route: {
                epoch: "integration-route",
                mode: "device",
                machineId: "integration-exit",
                deploymentId: "fixture",
                revision: 1,
                available: true,
                sourceOrder: ["integration-exit"],
              },
            });
        },
        dial: (target) => open(target.host, target.port),
      }
    );
    socket.on("message", (data) => mux.receive(Buffer.from(data as Buffer)));
    socket.on("close", () => mux.close());
    socket.on("error", () => {});
  });
  return server;
}
