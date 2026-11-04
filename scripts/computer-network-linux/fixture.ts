import { createConnection, createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { writeFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { createBrowserProxy } from "../../packages/plugin-sdk/src/browser-network/socks";
import { startComputerDns, createDnsExchange } from "../../apps/computer/src/computer-network-dns";
import { runOrdinaryProbe } from "../../apps/computer/src/computer-network-probe";
import { startControlFixture } from "../../packages/plugin-sdk/test/browser-network/control-fixture";
import { startManagementDiscovery } from "../../apps/computer/src/computer-network-management";

/** Test-only adapter to an existing SOCKS path; never opens a new app channel
 * or displaces the active computer's authenticated lease. */
async function upstream(host: string, port: number) {
  const [address, upstreamPort] = process.env.UPSTREAM_SOCKS!.split(":");
  const socket = createConnection({ host: address, port: Number(upstreamPort) });
  socket.on("error", () => {});
  socket.setTimeout(8000, () => socket.destroy(new Error("Upstream timeout")));
  const read = (size: number): Promise<Buffer> =>
    new Promise<Duplex>((resolve, reject) => {
      const ready = () => {
        const data = socket.read(size);
        if (data) {
          cleanup();
          resolve(data);
        }
      };
      const failed = () => {
        cleanup();
        reject(new Error("Upstream unavailable"));
      };
      const cleanup = () => {
        socket.off("readable", ready);
        socket.off("error", failed);
        socket.off("close", failed);
      };
      socket.on("readable", ready);
      socket.once("error", failed);
      socket.once("close", failed);
      ready();
    });
  try {
    socket.write(Buffer.from([5, 1, 0]));
    const greeting = await read(2);
    if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error("SOCKS greeting failed");
    const name = Buffer.from(host);
    const request = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.alloc(2)]);
    request.writeUInt16BE(port, request.length - 2);
    socket.write(request);
    const reply = await read(4);
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error("SOCKS dial failed");
    const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await read(1))[0]!;
    await read(length + 2);
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

if (process.argv[2] === "discovery") {
  const discovery = startManagementDiscovery(
    "http://future-server:8787",
    () => writeFileSync("/run/discovery-started", "ready"),
    {
      helper: "/fixture/openteam-computer-network.py",
      intervalMs: 100,
    }
  );
  process.once("SIGTERM", () => {
    discovery.stop();
    process.exit(0);
  });
  // Keep the test process alive while the production watcher uses an unref timer.
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "control") {
  startControlFixture(18794, upstream);
} else if (process.argv[2] === "dns-check") {
  const query = Buffer.from("007b01000001000000000000076578616d706c6503636f6d0000010001", "hex");
  console.log((await createDnsExchange({ open: upstream })(query)).toString("hex"));
} else if (process.argv[2] === "probe") {
  console.log(
    JSON.stringify(
      await runOrdinaryProbe("egress", {
        epoch: "live-canary",
        mode: "device",
        machineId: "selected-exit",
        available: true,
        revision: 1,
        deploymentId: "canary",
        sourceOrder: ["selected-exit"],
      })
    )
  );
} else if (process.argv[2] === "target") {
  httpServer((_req, res) => res.end("target-via-selected-route")).listen(8080, "::");
  httpServer((_req, res) => res.end("management-reachable")).listen(8787, "::");
} else {
  let count = 0;
  const open = process.env.UPSTREAM_SOCKS
    ? upstream
    : (host: string, port: number) =>
        new Promise((resolve, reject) => {
          writeFileSync("/run/relay-count", String(++count));
          const socket = createConnection({ host, port, allowHalfOpen: true });
          socket.once("error", reject);
          socket.once("connect", () => resolve(socket));
        });
  const proxy = createBrowserProxy(open);
  await proxy.listen(18791);
  await startComputerDns(
    process.env.UPSTREAM_SOCKS
      ? createDnsExchange({ open })
      : async (query) => {
          // Keep only the question before appending answers. Host resolvers
          // may add EDNS OPT records; retaining those after clearing ARCOUNT
          // makes a synthetic reply malformed on those Docker hosts.
          let end = 12;
          while (query[end]) {
            const length = query[end]!;
            if (length > 63 || end + length + 1 >= query.length)
              throw new Error("Invalid question");
            end += length + 1;
          }
          end += 5;
          if (end > query.length) throw new Error("Invalid question");
          const answer = Buffer.from(query.subarray(0, end));
          answer[2] = 0x81;
          answer[3] = 0x80;
          answer.writeUInt16BE(0, 8);
          answer.writeUInt16BE(0, 10);
          const kind = query.readUInt16BE(end - 4);
          answer.writeUInt16BE(kind === 1 ? 1 : 0, 6);
          if (kind !== 1) return answer;
          const record = Buffer.from([
            0xc0,
            0x0c,
            0,
            1,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            4,
            ...process.env.TARGET_IP!.split(".").map(Number),
          ]);
          return Buffer.concat([answer, record]);
        }
  );
  // A TCP listener also proves management replies survive application routing.
  createServer((socket) => socket.end("ready")).listen(18792, "127.0.0.1");
  console.log("relay-ready");
}
