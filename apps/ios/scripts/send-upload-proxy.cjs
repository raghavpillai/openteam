/** Loopback-only upload backpressure fixture for hosted ActionFailureTests.
 * Run beside parity-server.ts; Node must own this socket because Bun eagerly
 * buffers loopback bodies before its Request reader can apply backpressure.
 *   SWIFT_PARITY_PORT=20084 bun apps/ios/scripts/parity-server.ts
 *   node apps/ios/scripts/send-upload-proxy.cjs
 */
const http = require("node:http");
const { once } = require("node:events");
const { setTimeout: sleep } = require("node:timers/promises");

const port = Number(process.env.SWIFT_UPLOAD_PROXY_PORT || 20086);
const upstreamPort = Number(process.env.SWIFT_PARITY_PORT || 20084);
const bytesPerSecond = Number(process.env.SWIFT_UPLOAD_BYTES_PER_SECOND || 1024 * 1024);
const chunkBytes = 16 * 1024;
if (!(bytesPerSecond > 0)) throw new Error("Upload fixture rate must be positive");

const server = http.createServer({ highWaterMark: chunkBytes }, (request, response) => {
  if (request.url === "/__qa/proxy-health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ bytesPerSecond, upstreamPort }));
    return;
  }
  const upstream = http.request({
    hostname: "127.0.0.1", port: upstreamPort, path: request.url,
    method: request.method, headers: { ...request.headers, host: `127.0.0.1:${upstreamPort}` },
    highWaterMark: chunkBytes,
  }, incoming => {
    response.writeHead(incoming.statusCode, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
  if (request.method !== "POST" || request.url !== "/api/v0/assets") {
    request.pipe(upstream);
    return;
  }
  // Reading only one small chunk at a time pauses Node's request stream and
  // eventually fills the actual TCP receive window. URLSession then reports
  // increasing sent-body bytes over time instead of just a delayed response.
  void (async () => {
    try {
      for await (const received of request) {
        for (let offset = 0; offset < received.length; offset += chunkBytes) {
          const chunk = received.subarray(offset, offset + chunkBytes);
          await sleep(Math.ceil(chunk.length / bytesPerSecond * 1000));
          if (upstream.destroyed) return;
          if (!upstream.write(chunk)) await once(upstream, "drain");
        }
      }
      upstream.end();
    } catch {
      upstream.destroy();
    }
  })();
});
server.requestTimeout = 180_000;
server.listen(port, "127.0.0.1", () => {
  console.log(`Upload backpressure fixture http://127.0.0.1:${port} → :${upstreamPort} (${bytesPerSecond} bytes/s)`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
}
