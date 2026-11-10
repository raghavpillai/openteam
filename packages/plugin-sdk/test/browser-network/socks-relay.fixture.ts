// Local integration driver: production Node sockets and relay client, with a
// test broker/exit controlled by the parent process. No external destinations.
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { BrowserNetworkClient } from "../../src/browser-network/client";
import { createBrowserProxy } from "../../src/browser-network/socks";

let client: BrowserNetworkClient | undefined;
let proxy: ReturnType<typeof createBrowserProxy> | undefined;
let port = 0;
let abandoned: Socket | undefined;
const host = Buffer.from("desktop-only.example");
const request = Buffer.concat([
  Buffer.from([5, 1, 0, 5, 1, 0, 3, host.length]),
  host,
  Buffer.from([1, 187]),
]);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "start") {
    client = new BrowserNetworkClient({
      role: "computer",
      url: command.url,
      headers: { authorization: "Bearer internal" },
      changed: () => {
        if (client?.available()) console.log(JSON.stringify({ ready: true }));
      },
    });
    proxy = createBrowserProxy((host, port, signal) => client!.open(host, port, signal));
    void proxy.listen(0).then((value) => {
      port = value;
      client!.start();
    });
  } else if (command.op === "open") {
    abandoned = createConnection({ host: "127.0.0.1", port });
    let bytes = Buffer.alloc(0), reported = false;
    abandoned.on("error", () => {});
    abandoned.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 12 && !reported) {
        reported = true; console.log(JSON.stringify({ connectCode: bytes[3] }));
      }
    });
    abandoned.once("connect", () => abandoned!.write(request));
  } else if (command.op === "reset") {
    abandoned!.resetAndDestroy();
  } else if (command.op === "recover") {
    const socket = createConnection({ host: "127.0.0.1", port });
    let bytes = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
    });
    socket.once("connect", () => socket.end(Buffer.concat([request, Buffer.from("recovered")])));
    socket.once("close", () => console.log(JSON.stringify({ recovered: bytes.toString("hex") })));
  }
});
process.once("SIGTERM", () => {
  abandoned?.destroy();
  client?.stop();
  void proxy?.close().then(() => process.exit(0));
});
