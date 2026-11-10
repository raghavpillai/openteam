// Test-only device: maps the reserved browser-target.test hostname to controlled local servers.
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { BrowserNetworkClient } from "../../src/browser-network/client";
import type { IncomingMessage, ServerResponse } from "node:http";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const bytes = randomBytes(4 * 1024 * 1024),
  digest = createHash("sha256").update(bytes).digest("hex");
const handler = (request: IncomingMessage, response: ServerResponse) => {
  if (request.headers.host === "speed.cloudflare.com") {
    if (request.method === "POST") {
      let bytes = 0;
      request.on("data", chunk => { bytes += chunk.length; });
      request.on("end", () => response.end(JSON.stringify({bytes})));
    } else {
      const bytes = Number(new URL(request.url!, "https://fixture").searchParams.get("bytes"));
      response.end(Buffer.alloc(bytes));
    }
    return;
  }
  if (request.headers.host === "ipwho.is") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ success: true, ip: "203.0.113.10", city: "Device Exit", country: "Fixture" }));
    return;
  }
  const path = new URL(request.url!, "http://fixture").pathname;
  if (path === "/download-large") {
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-length", bytes.length * 64);
    let remaining = 64;
    const send = () => {
      while (remaining > 0 && !response.destroyed) {
        remaining--;
        if (!response.write(bytes)) {
          response.once("drain", send);
          return;
        }
      }
      if (!response.destroyed) response.end();
    };
    send();
    return;
  }
  if (path === "/download") {
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("x-content-hash", digest);
    response.end(bytes);
    return;
  }
  if (path === "/upload") {
    let length = 0;
    request.on("data", (chunk) => (length += chunk.length));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ length }));
    });
    return;
  }
  if (path === "/api" || path === "/iframe") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ via: "device" }));
    return;
  }
  if (path === "/sw.js") {
    response.setHeader("content-type", "application/javascript");
    response.end(
      `self.addEventListener('install',event=>event.waitUntil(fetch('/api')));self.addEventListener('activate',event=>event.waitUntil(clients.claim()));`
    );
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(
    `<!doctype html><title>Network fixture</title><script>window.results={};fetch('/api').then(r=>r.json()).then(v=>results.api=v.via);const s=new WebSocket(location.protocol==='https:'?'wss://'+location.host+'/ws':'ws://'+location.host+'/ws');s.onopen=()=>s.send('through-device');s.onmessage=e=>{results.ws=e.data;s.close()};if(navigator.serviceWorker)navigator.serviceWorker.register('/sw.js').then(()=>results.worker=true).catch(()=>results.worker=false);</script><iframe src="/iframe"></iframe>`
  );
};
const http = createServer(handler),
  https = config.cert
    ? createTlsServer({ cert: readFileSync(config.cert), key: readFileSync(config.key) }, handler)
    : null;
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (socket) =>
  socket.on("message", (data, binary) => socket.send(data, { binary }))
);
for (const server of [http, https])
  if (server) {
    server.on("upgrade", (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  }
const peer = new BrowserNetworkClient({
  role: "device",
  url: config.url,
  headers: config.headers,
  machineId: config.machineId,
  deploymentId: config.deploymentId,
  dial: async (target, signal) => {
    if (!["browser-target.test", "ipwho.is", "speed.cloudflare.com"].includes(target.host) || ![80, 443].includes(target.port))
      throw Error("Unexpected test destination");
    signal.throwIfAborted();
    const port = (target.port === 443 ? https : http)?.address();
    if (!port || typeof port === "string") throw Error("No fixture target");
    return await new Promise((resolve, reject) => {
      const socket = createConnection(
        { host: "127.0.0.1", port: port.port, allowHalfOpen: true },
        () => resolve(socket)
      );
      socket.on("error", reject);
    });
  },
});
peer.start();
console.log(JSON.stringify({ started: true, digest }));
process.once("SIGTERM", () => {
  peer.stop();
  wss.close();
  http.close();
  https?.close();
  setTimeout(() => process.exit(0), 100).unref();
});
