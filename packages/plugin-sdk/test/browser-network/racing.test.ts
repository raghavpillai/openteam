import { expect, test } from "bun:test";
import { Socket } from "node:net";
import { dialTarget } from "../../src/browser-network/policy";
import { currentConnectivity } from "../../src/browser-network/protocol";
const target = { host: "example.com", port: 443, epoch: "e" };
const addresses = [
  { address: "2606:4700:4700::1111", family: 6 },
  { address: "2001:4860:4860::8888", family: 6 },
  { address: "1.1.1.1", family: 4 },
];

test("a blackholed IPv6 attempt cannot delay IPv4 for its full timeout", async () => {
  const sockets: Socket[] = [],
    called: string[] = [];
  const started = performance.now();
  const socket = await dialTarget(target, new AbortController().signal, {
    publicOnly: true,
    lookup: (async () => addresses) as any,
    dial: ((options: any) => {
      const socket = new Socket();
      sockets.push(socket);
      called.push(options.host);
      if (options.family === 4) setTimeout(() => socket.emit("connect"), 5);
      return socket;
    }) as any,
  });
  expect(called).toEqual([addresses[0]!.address, "1.1.1.1"]);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(sockets[0]!.destroyed).toBe(true);
  expect(socket.destroyed).toBe(false);
  socket.destroy();
});

test("cancellation destroys every racing socket and starts no further attempt", async () => {
  const controller = new AbortController(),
    sockets: Socket[] = [];
  const result = dialTarget(target, controller.signal, {
    lookup: (async () => addresses) as any,
    dial: (() => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    }) as any,
  });
  await Bun.sleep(300);
  controller.abort();
  await expect(result).rejects.toThrow();
  expect(sockets).toHaveLength(2);
  expect(sockets.every((s) => s.destroyed)).toBe(true);
  await Bun.sleep(300);
  expect(sockets).toHaveLength(2);
});

test("private answers reject the entire set before racing any public address", async () => {
  let dials = 0;
  await expect(
    dialTarget(target, new AbortController().signal, {
      publicOnly: true,
      lookup: (async () => [...addresses, { address: "192.168.1.1", family: 4 }]) as any,
      dial: (() => {
        dials++;
        return new Socket();
      }) as any,
    })
  ).rejects.toThrow("destination_blocked");
  expect(dials).toBe(0);
});

test("missing and obsolete health never become current", () => {
  const health = {
    epoch: "e",
    sourceId: "a",
    checkedAt: null,
    ipv4: { state: "working" as const },
    ipv6: { state: "checking" as const },
  };
  expect(currentConnectivity(undefined, undefined, null)).toBeUndefined();
  expect(currentConnectivity(health, "next", "a")).toBeUndefined();
  expect(currentConnectivity(health, "e", "b")).toBeUndefined();
  expect(currentConnectivity(health, "e", "a")).toBe(health);
});
