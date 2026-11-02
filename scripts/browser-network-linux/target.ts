// Test-only HTTP/TLS/WS and DNS origin. Runs on a Docker --internal network with
// a synthetic globally routable address so the production public-address policy runs unchanged.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
const requests: Array<{ path: string; ip: string | undefined; method: string | undefined }> = [];
const queries: Array<{ name: string; type: number; ip: string }> = [];
const chunk = Buffer.alloc(64 * 1024, 0x5a);
const handler = (req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url!, "http://fixture").pathname;
  if (path === "/stats") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ requests, queries }));
    return;
  }
  requests.push({ path, ip: req.socket.remoteAddress, method: req.method });
  res.setHeader("cache-control", "no-store");
  if (req.headers.host === "ipwho.is") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        ip: req.socket.remoteAddress?.replace(/^::ffff:/, ""),
        city: "Isolated Linux",
        country: "Fixture",
      })
    );
    return;
  }
  if (req.headers.host === "speed.cloudflare.com") {
    if (req.method === "POST" && path === "/__up") {
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
      });
      req.on("end", () => res.end(JSON.stringify({ bytes })));
    } else {
      const bytes = Number(new URL(req.url!, "https://fixture").searchParams.get("bytes"));
      if (![0, 1048576].includes(bytes)) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.end(Buffer.alloc(bytes));
    }
    return;
  }
  if (path === "/api") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ip: req.socket.remoteAddress }));
    return;
  }
  if (path === "/iframe") {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><p>Device iframe</p>");
    return;
  }
  if (path === "/upload") {
    const hash = createHash("sha256");
    let bytes = 0;
    req.on("data", (b) => {
      bytes += b.length;
      hash.update(b);
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ bytes, hash: hash.digest("hex"), ip: req.socket.remoteAddress }));
    });
    return;
  }
  if (path === "/download" || path === "/large" || path === "/slow") {
    let remaining = path === "/large" ? 4096 : path === "/slow" ? 1024 : 64;
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-length", remaining * chunk.length);
    res.setHeader("content-disposition", 'attachment; filename="device-download.bin"');
    const send = () => {
      if (res.destroyed) return;
      while (remaining > 0) {
        remaining--;
        if (path === "/slow") {
          res.write(chunk);
          setTimeout(send, 25).unref();
          return;
        }
        if (!res.write(chunk)) {
          res.once("drain", send);
          return;
        }
      }
      res.end();
    };
    send();
    return;
  }
  if (path === "/worker.js" || path === "/sw.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(
      path === "/worker.js"
        ? "fetch('/api').then(r=>r.json()).then(v=>postMessage(v.ip))"
        : "self.addEventListener('install',e=>e.waitUntil(fetch('/api')));self.addEventListener('activate',e=>e.waitUntil(clients.claim()));"
    );
    return;
  }
  if (path === "/script.js") {
    res.setHeader("content-type", "application/javascript");
    res.end("window.scriptLoaded=true");
    return;
  }
  if (path === "/style.css") {
    res.setHeader("content-type", "text/css");
    res.end("body{color:rgb(0,128,0)}");
    return;
  }
  if (path === "/image.svg") {
    res.setHeader("content-type", "image/svg+xml");
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>'
    );
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(
    `<!doctype html><title>Linux device network fixture</title><link rel="stylesheet" href="/style.css"><script src="/script.js"></script><img src="/image.svg"><iframe src="/iframe"></iframe><input type="file" id="upload"><a href="/download" download id="download">Download</a><script>window.results={};fetch('/api').then(r=>r.json()).then(v=>results.api=v.ip);new Worker('/worker.js').onmessage=e=>results.worker=e.data;const ws=new WebSocket(location.protocol==='https:'?'wss://'+location.host+'/ws':'ws://'+location.host+'/ws');ws.onopen=()=>ws.send('device-echo');ws.onmessage=e=>{results.ws=e.data;ws.close()};if(navigator.serviceWorker)navigator.serviceWorker.register('/sw.js').then(()=>results.serviceWorker=true);</script>`
  );
};
const websocket = new WebSocketServer({ noServer: true });
websocket.on("connection", (socket) =>
  socket.on("message", (data, binary) => socket.send(data, { binary }))
);
for (const server of [
  createServer(handler),
  createHttpsServer(
    { cert: readFileSync("/tmp/cert.pem"), key: readFileSync("/tmp/key.pem") },
    handler
  ),
]) {
  server.on("upgrade", (req, socket, head) =>
    websocket.handleUpgrade(req, socket, head, (ws) => websocket.emit("connection", ws, req))
  );
  server.listen(server instanceof (await import("node:https")).Server ? 443 : 80, "0.0.0.0");
}
createServer((req, res) => {
  requests.push({ path: "FORBIDDEN_PORT", ip: req.socket.remoteAddress, method: req.method });
  res.end("forbidden");
}).listen(8080);
const dns = createSocket("udp4");
dns.on("message", (packet, remote) => {
  try {
    let offset = 12;
    const labels: string[] = [];
    while (packet[offset]) {
      const length = packet[offset++]!;
      labels.push(packet.subarray(offset, offset + length).toString());
      offset += length;
    }
    offset++;
    const type = packet.readUInt16BE(offset),
      name = labels.join(".");
    offset += 4;
    queries.push({ name, type, ip: remote.address });
    const known = [
      "browser-target.test",
      "mixed-target.test",
      "ipwho.is",
      "speed.cloudflare.com",
    ].includes(name);
    const addresses =
      known && type === 1
        ? name === "mixed-target.test"
          ? [
              [11, 77, 0, 80],
              [127, 0, 0, 1],
            ]
          : [[11, 77, 0, 80]]
        : [];
    const header = Buffer.from(packet.subarray(0, 12));
    header.writeUInt16BE(known ? 0x8180 : 0x8183, 2);
    header.writeUInt16BE(addresses.length, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    const answers = addresses.map((address) =>
      Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, ...address])
    );
    dns.send(
      Buffer.concat([header, packet.subarray(12, offset), ...answers]),
      remote.port,
      remote.address
    );
  } catch {
    /* Ignore malformed fixture requests. */
  }
});
dns.bind(53, "0.0.0.0");
