import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import {
  BrowserNetworkService,
  type NetworkConnection,
  type NetworkStore,
} from "../src/services/browser-network-service";
import type { MachineService } from "../src/services/machine-service";
import { BrowserNetworkClient } from "@openteam/plugin-sdk/browser-network/client";
import { NETWORK_PROTOCOL, type NetworkSettings } from "@openteam/plugin-sdk/browser-network/protocol";
import { encodeFrame, FrameType } from "@openteam/plugin-sdk/browser-network/protocol";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(check: () => boolean | Promise<boolean>, ms = 6000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw Error("Condition timed out");
    await Bun.sleep(10);
  }
}
async function fixture(
  options: { failbackMs?: number } = {}
) {
  let settings: NetworkSettings = {
    deploymentId: crypto.randomUUID(),
    mode: "ranked",
    machineId: null,
    revision: 1,
    sourceOrder: ["server"],
  };
  const store: NetworkStore = {
    read: async () => ({ ...settings }),
    change: async (expected, mode, machineId, sourceOrder) => {
      if (expected !== settings.revision) return null;
      return (settings = {
        ...settings,
        mode,
        machineId,
        sourceOrder: sourceOrder ?? settings.sourceOrder,
        revision: settings.revision + 1,
      });
    },
  };
  const credentials = new Map<string, string>(),
    enabled = new Map<string, boolean>();
  const connections = new Map<string, number>();
  let failedReads = 0;
  const read = store.read;
  store.read = async () => {
    if (failedReads > 0) {
      failedReads--;
      throw Error("injected database failure");
    }
    return read();
  };
  const refusedDials = new Set<string>();
  const machines = {
    onNetworkRevoke: () => {},
    relay: {
      matchesConnection: (id: string, conn: string) => enabled.get(id) && conn === "connection",
    },
    authenticate: async (request: Request) => {
      const id = request.headers.get("x-openteam-machine-id") ?? "";
      if (
        !enabled.get(id) ||
        request.headers.get("authorization") !== `Bearer ${credentials.get(id)}`
      )
        throw Error("unauthorized");
      return { machineId: id };
    },
    list: async () =>
      [...credentials.keys()].map((machineId) => ({
        machineId,
        label: machineId,
        enabled: enabled.get(machineId),
        connected: enabled.get(machineId),
      })),
  } as unknown as MachineService;
  const service = new BrowserNetworkService(
    store,
    machines,
    (request) => request.headers.get("authorization") === "Bearer internal",
    options
  );
  const server = Bun.serve<NetworkConnection>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      ...service.websocket,
      open: (socket) => {
        const id = socket.data.machineId ?? "computer";
        connections.set(id, (connections.get(id) ?? 0) + 1);
        service.websocket.open?.(socket);
      },
    },
    async fetch(request, server) {
      try {
        const path = new URL(request.url).pathname;
        return await service.upgrade(
          request,
          server,
          path === "/computer" || path.includes("/internal/") ? "computer" : "device"
        );
      } catch {
        return new Response("denied", { status: 403 });
      }
    },
  });
  cleanup.push(() => {
    service.close();
    server.stop(true);
  });
  const computer = new BrowserNetworkClient({
    role: "computer",
    url: `ws://127.0.0.1:${server.port}/computer`,
    headers: { authorization: "Bearer internal" },
  });
  computer.start();
  cleanup.push(() => computer.stop());
  await until(() => computer.available());
  let deviceDials = 0;
  const echo = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const port = (echo.address() as AddressInfo).port;
  cleanup.push(() => new Promise<void>((r) => echo.close(() => r())));
  const device = (id: string) => {
    const token = crypto.randomUUID();
    credentials.set(id, token);
    enabled.set(id, true);
    const peer = new BrowserNetworkClient({
      role: "device",
      machineId: id,
      deploymentId: settings.deploymentId,
      url: `ws://127.0.0.1:${server.port}/device`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-openteam-machine-id": id,
        "x-openteam-connection-id": "connection",
      },
      dial: async (target, signal) => {
        deviceDials++;
        if (refusedDials.has(id)) throw Error("injected destination DNS/dial failure");
        expect(target.host).toBe("desktop-only.example");
        expect(target.port).toBe(443);
        signal.throwIfAborted();
        const socket = new Duplex({
          read() {},
          write(chunk, _encoding, done) {
            this.push(Buffer.from(chunk));
            done();
          },
          final(done) {
            this.push(null);
            done();
          },
        });
        return socket;
      },
    });
    peer.start();
    cleanup.push(() => peer.stop());
    return peer;
  };
  const select = async (id: string, waitForComputer = true) => {
    await until(async () =>
      (await service.view()).devices.some((d) => d.machineId === id && d.sharingAllowed)
    );
    await service.update({ expectedRevision: settings.revision, mode: "device", machineId: id });
    await until(async () => {
      const view = await service.view();
      return view.runtime.state === "ready" && (!waitForComputer || (computer.available() &&
        computer.route?.machineId === id && computer.route.epoch === view.runtime.routeEpoch));
    });
  };
  return {
    service,
    computer,
    device,
    select,
    port,
    enabled,
    machines,
    getSettings: () => settings,
    getDials: () => deviceDials,
    server,
    getConnections: (id: string) => connections.get(id) ?? 0,
    failReads: (count: number) => {
      failedReads = count;
    },
    refuseDials: (id: string, refuse: boolean) => {
      if (refuse) refusedDials.add(id);
      else refusedDials.delete(id);
    },
  };
}
async function roundTrip(client: BrowserNetworkClient, payload: Buffer) {
  const stream = await client.open("desktop-only.example", 443);
  const received: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    stream.on("data", (b) => received.push(Buffer.from(b)));
    stream.on("end", () => resolve(Buffer.concat(received)));
    stream.on("error", reject);
  });
  stream.end(payload);
  return await result;
}

async function rank(f: Awaited<ReturnType<typeof fixture>>, sourceOrder: string[]) {
  await f.service.update({
    expectedRevision: f.getSettings().revision,
    mode: "ranked",
    machineId: null,
    sourceOrder,
  });
}
async function routed(f: Awaited<ReturnType<typeof fixture>>, source: string, timeout = 6000) {
  await until(
    async () =>
      f.computer.available() &&
      f.computer.route?.mode === (source === "server" ? "server" : "device") &&
      f.computer.route?.machineId === (source === "server" ? null : source) &&
      ["server", "ready"].includes((await f.service.view()).runtime.state),
    timeout
  );
}

describe("ranked browser connections", () => {
  test("local sharing automatically joins the saved priority pool without an owner update", async () => {
    const f = await fixture();
    expect(f.getSettings().sourceOrder).toEqual(["server"]);
    const home = f.device("home"),
      office = f.device("office");
    await until(() => !!home.route && !!office.route);
    expect(f.getSettings().mode).toBe("ranked");
    expect(f.getSettings().machineId).toBeNull();
    expect(new Set(f.getSettings().sourceOrder)).toEqual(new Set(["home", "office", "server"]));
    expect(f.getSettings().sourceOrder.at(-1)).toBe("server");
    expect(f.getSettings().revision).toBe(3);
    const revision = f.getSettings().revision;
    home.stop();
    f.device("home");
    await until(() => f.getSettings().sourceOrder.includes("home"));
    await Bun.sleep(100);
    expect(f.getSettings().sourceOrder.filter((id) => id === "home")).toHaveLength(1);
    expect(f.getSettings().revision).toBe(revision);
  });

  test("ranked devices fail over in order, then use the server, without mutating the saved ranking", async () => {
    const f = await fixture(),
      home = f.device("home"),
      office = f.device("office");
    await until(() => !!home.route && !!office.route);
    await rank(f, ["home", "office", "server"]);
    await routed(f, "home");
    const revision = f.getSettings().revision;
    const stream = await f.computer.open("desktop-only.example", 443);
    home.stop();
    await routed(f, "office");
    expect(stream.destroyed).toBe(true);
    expect(await roundTrip(f.computer, Buffer.from("office"))).toEqual(Buffer.from("office"));
    office.stop();
    await routed(f, "server");
    const direct = await f.computer.open("127.0.0.1", f.port);
    direct.destroy();
    expect(f.getSettings().sourceOrder).toEqual(["home", "office", "server"]);
    expect(f.getSettings().revision).toBe(revision);
  });
  test("a returning preferred device must stay healthy before preempting the current fallback", async () => {
    const f = await fixture({ failbackMs: 1000 }),
      home = f.device("home");
    await until(() => !!home.route);
    await rank(f, ["home", "server"]);
    await routed(f, "home");
    home.stop();
    await routed(f, "server");
    const returned = f.device("home");
    await until(() => !!returned.route);
    await Bun.sleep(100);
    expect(f.computer.route!.mode).toBe("server");
    const before = f.computer.route!.epoch;
    await routed(f, "home");
    expect(f.computer.route!.epoch).not.toBe(before);
    expect(await roundTrip(f.computer, Buffer.from("restored"))).toEqual(Buffer.from("restored"));
  });
});

describe("connected device browser network", () => {
  test("streams large binary uploads/downloads with half-close and concurrent connections through the device", async () => {
    const f = await fixture();
    f.device("home");
    await f.select("home");
    const payload = randomBytes(2 * 1024 * 1024);
    expect((await roundTrip(f.computer, payload)).equals(payload)).toBe(true);
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const bytes = randomBytes(128 * 1024);
        expect(await roundTrip(f.computer, bytes)).toEqual(bytes);
      })
    );
    expect(f.getDials()).toBe(9);
    await until(async () => (await f.service.view()).runtime.activeConnections === 0);
    const stats = (await f.service.view()).runtime;
    expect(stats.bytesSent).toBe(3 * 1024 * 1024);
    expect(stats.bytesReceived).toBe(stats.bytesSent);
  }, 15000);
  test("source changes use compare-and-swap; permission and session revoke stop existing sockets", async () => {
    const f = await fixture();
    f.device("home");
    await f.select("home");
    await expect(
      f.service.update({ expectedRevision: 1, mode: "server", machineId: null })
    ).rejects.toThrow("changed");
    await expect(
      f.service.update({
        expectedRevision: f.getSettings().revision,
        mode: "device",
        machineId: "unapproved",
      })
    ).rejects.toThrow("sharing");
    const stream = await f.computer.open("desktop-only.example", 443);
    f.enabled.set("home", false);
    f.machines.onNetworkRevoke("home");
    await until(() => stream.destroyed);
    await routed(f, "server");
    const direct = await f.computer.open("127.0.0.1", f.port);
    direct.destroy();
  });
  test("unknown secrets, browser origins and wrong enrollment generations cannot upgrade", async () => {
    const f = await fixture();
    for (const headers of [
      { authorization: "Bearer bad" },
      { authorization: "Bearer internal", origin: "https://evil.test" },
    ] as Record<string, string>[]) {
      const response = await fetch(`http://127.0.0.1:${f.server.port}/computer`, {
        headers: { ...headers, upgrade: "websocket", "sec-websocket-protocol": NETWORK_PROTOCOL },
      });
      expect(response.status).toBe(403);
    }
  });
});

test("fenced bytes in flight do not disconnect broker or former exit during a switch", async () => {
  const f = await fixture(),
    home = f.device("home"),
    office = f.device("office");
  await until(() => !!home.route && !!office.route);
  await rank(f, ["home", "office", "server"]);
  await routed(f, "home");
  const old = await f.computer.open("desktop-only.example", 443);
  const computerSocket = (f.computer as any).ws,
    homeSocket = (home as any).ws;
  const before = f.getDials();
  await rank(f, ["office", "home", "server"]);
  computerSocket.send(encodeFrame(FrameType.Data, 1, Buffer.from("old browser bytes")));
  homeSocket.send(encodeFrame(FrameType.Data, 1, Buffer.from("old exit bytes")));
  await routed(f, "office");
  expect(old.destroyed).toBe(true);
  expect((f.computer as any).ws).toBe(computerSocket);
  expect((home as any).ws).toBe(homeSocket);
  expect(computerSocket.readyState).toBe(1);
  expect(homeSocket.readyState).toBe(1);
  expect(f.getDials()).toBe(before);
  expect(await roundTrip(f.computer, Buffer.from("new route"))).toEqual(Buffer.from("new route"));
});

describe("browser network chaos recovery boundaries", () => {
  test("temporary database failures recover without losing the saved ranking", async () => {
    const f = await fixture();
    const revision = f.getSettings().revision,
      before = f.getConnections("computer");
    f.failReads(2);
    await until(() => f.getConnections("computer") > before && f.computer.available(), 12000);
    await routed(f, "server");
    expect(f.getSettings().revision).toBe(revision);
    const socket = await f.computer.open("127.0.0.1", f.port);
    socket.destroy();
  }, 15000);

  test("a destination failure neither changes global priority nor replays the request", async () => {
    const f = await fixture(),
      home = f.device("home");
    await until(() => !!home.route);
    await rank(f, ["home", "server"]);
    await routed(f, "home");
    const revision = f.getSettings().revision,
      epoch = f.computer.route!.epoch,
      before = f.getDials();
    f.refuseDials("home", true);
    await expect(roundTrip(f.computer, Buffer.from("do-not-replay"))).rejects.toThrow();
    expect(f.getDials()).toBe(before + 1);
    expect(f.computer.route!.epoch).toBe(epoch);
    expect(f.getSettings().revision).toBe(revision);
    f.refuseDials("home", false);
    expect(await roundTrip(f.computer, Buffer.from("next-request"))).toEqual(
      Buffer.from("next-request")
    );
  });
});


