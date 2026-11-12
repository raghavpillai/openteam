import { expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";
import { createBrowserProxy } from "../../src/browser-network/socks";

const greeting = Buffer.from([5, 1, 0]);

type Client = { socket: Socket; reply: Buffer[] };

function connect(port: number, clients: Client[]) {
  const socket = createConnection({ host: "127.0.0.1", port });
  const entry: Client = { socket, reply: [] };
  socket.on("data", (chunk) => entry.reply.push(chunk));
  socket.on("error", () => {});
  clients.push(entry);
  return new Promise<Client>((resolve, reject) => {
    socket.once("connect", () => resolve(entry));
    socket.once("error", reject);
  });
}

const admitted = (clients: Client[]) =>
  clients.filter((client) => client.reply[0]?.[0] === 5 && client.reply[0]?.[1] === 0).length;

test("rejected connections release capacity instead of leaking slots", async () => {
  const proxy = createBrowserProxy(async () => {
    throw new Error("unused");
  }, 2);
  const port = await proxy.listen(0);
  const clients: Client[] = [];
  try {
    for (let round = 0; round < 3; round++) {
      const burst: Client[] = [];
      for (let index = 0; index < 6; index++) await connect(port, burst);
      for (const client of burst) client.socket.write(greeting);
      await Bun.sleep(150);
      // The limit is not degraded by the rejected connections of earlier rounds.
      expect(admitted(burst)).toBe(2);
      for (const client of burst) client.socket.destroy();
      await Bun.sleep(50);
      clients.push(...burst);
    }
  } finally {
    for (const client of clients) client.socket.destroy();
    await proxy.close();
  }
}, 15_000);

test("abandoned half-open clients release their slot immediately", async () => {
  const proxy = createBrowserProxy(async () => {
    throw new Error("unused");
  }, 1);
  const port = await proxy.listen(0);
  const clients: Client[] = [];
  try {
    // Holds the only slot, never sends a greeting, then gives up.
    const first = await connect(port, clients);
    first.socket.end();
    await Bun.sleep(100);
    const burst: Client[] = [];
    const second = await connect(port, burst);
    second.socket.write(greeting);
    await Bun.sleep(150);
    expect(admitted(burst)).toBe(1);
    clients.push(...burst);
  } finally {
    for (const client of clients) client.socket.destroy();
    await proxy.close();
  }
}, 15_000);
