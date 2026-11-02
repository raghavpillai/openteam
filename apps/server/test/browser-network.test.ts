import { afterEach, describe, expect, test } from "bun:test";
import { createServer, createConnection, type AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  BrowserNetworkService,
  type NetworkConnection,
  type NetworkStore,
} from "../src/services/browser-network-service";
import type { MachineService } from "../src/services/machine-service";
import { BrowserNetworkClient } from "@openteam/plugin-sdk/browser-network/client";
import {
  NETWORK_PROTOCOL,
  LEASE_MS,
  type NetworkSettings,
} from "@openteam/plugin-sdk/browser-network/protocol";
import {
  decodeFrame,
  encodeFrame,
  FrameType,
  parseJson,
} from "@openteam/plugin-sdk/browser-network/protocol";
import { createBrowserProxy } from "@openteam/plugin-sdk/browser-network/socks";
import { managedBrowserNetworkArguments } from "../../computer/src/browser-network";

const browserPath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  chromium.executablePath(),
].find((path) => path && existsSync(path));
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
async function fixture(options: { failbackMs?: number } = {}) {
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
  let silent = false;
  const silentDevices = new Set<string>();
  const appliedDelays = new Map<string, number>();
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
      message: (socket, message) => {
        if (
          (silent || silentDevices.has(socket.data.machineId ?? "")) &&
          typeof message !== "string"
        ) {
          const frame = decodeFrame(new Uint8Array(message));
          if (frame.type === FrameType.Control && parseJson(frame.payload).op === "lease") return;
        }
        const delay = appliedDelays.get(
          socket.data.role === "computer" ? "computer" : (socket.data.machineId ?? "")
        );
        if (delay && typeof message !== "string") {
          const frame = decodeFrame(new Uint8Array(message));
          if (frame.type === FrameType.Control && parseJson(frame.payload).op === "applied") {
            if (Number.isFinite(delay))
              setTimeout(() => service.websocket.message(socket, message), delay);
            return;
          }
        }
        service.websocket.message(socket, message);
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
        expect(target.host).toBe("desktop-only.example");
        expect(target.port).toBe(443);
        signal.throwIfAborted();
        return new Duplex({
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
      },
    });
    peer.start();
    cleanup.push(() => peer.stop());
    return peer;
  };
  const select = async (id: string) => {
    await until(async () =>
      (await service.view()).devices.some((d) => d.machineId === id && d.sharingAllowed)
    );
    await service.update({ expectedRevision: settings.revision, mode: "device", machineId: id });
    await until(async () => (await service.view()).runtime.state === "ready");
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
    pauseLeases: () => {
      silent = true;
    },
    silenceDevice: (id: string) => silentDevices.add(id),
    delayApplied: (id: string, ms: number) => appliedDelays.set(id, ms),
    register: (id: string) => {
      const token = crypto.randomUUID();
      credentials.set(id, token);
      enabled.set(id, true);
      return token;
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
  test("automatic pool additions preserve an explicitly elevated server and conflict with stale drafts", async () => {
    const f = await fixture(),
      home = f.device("home");
    await until(() => !!home.route);
    await rank(f, ["server", "home"]);
    const revision = f.getSettings().revision;
    const office = f.device("office");
    await until(() => !!office.route);
    expect(f.getSettings().sourceOrder).toEqual(["server", "home", "office"]);
    await routed(f, "server");
    await expect(
      f.service.update({
        expectedRevision: revision,
        mode: "ranked",
        machineId: null,
        sourceOrder: ["home", "server"],
      })
    ).rejects.toThrow("changed");
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
  test("server priority is respected and standby changes do not interrupt its active sockets", async () => {
    const f = await fixture(),
      home = f.device("home");
    await until(() => !!home.route);
    await rank(f, ["server", "home"]);
    await routed(f, "server");
    const epoch = f.computer.route!.epoch,
      direct = await f.computer.open("127.0.0.1", f.port);
    home.stop();
    await Bun.sleep(100);
    expect(direct.destroyed).toBe(false);
    expect(f.computer.route!.epoch).toBe(epoch);
    const returned = f.device("home");
    await until(() => !!returned.route);
    expect(direct.destroyed).toBe(false);
    expect(f.computer.route!.epoch).toBe(epoch);
    direct.destroy();
  });
  test("reordering immediately applies the new preference and uses conditional revisions", async () => {
    const f = await fixture(),
      home = f.device("home"),
      office = f.device("office");
    await until(() => !!home.route && !!office.route);
    await rank(f, ["home", "server", "office"]);
    await routed(f, "home");
    const old = f.getSettings().revision;
    await rank(f, ["office", "server", "home"]);
    await routed(f, "office");
    await expect(
      f.service.update({
        expectedRevision: old,
        mode: "ranked",
        machineId: null,
        sourceOrder: ["server"],
      })
    ).rejects.toThrow("changed");
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
  test("revocation moves to the next approved device and offline saved entries can still be reordered", async () => {
    const f = await fixture(),
      home = f.device("home"),
      office = f.device("office");
    await until(() => !!home.route && !!office.route);
    await rank(f, ["home", "office", "server"]);
    await routed(f, "home");
    const stream = await f.computer.open("desktop-only.example", 443);
    f.enabled.set("home", false);
    f.machines.onNetworkRevoke("home");
    await routed(f, "office");
    expect(stream.destroyed).toBe(true);
    await rank(f, ["home", "server", "office"]);
    await routed(f, "server");
    expect(f.getSettings().sourceOrder).toEqual(["home", "server", "office"]);
  });
  test("a silent selected device loses eligibility after its lease, even while its socket remains open", async () => {
    const f = await fixture(),
      home = f.device("home");
    await until(() => !!home.route);
    await rank(f, ["home", "server"]);
    await routed(f, "home");
    const stream = await f.computer.open("desktop-only.example", 443);
    const started = performance.now();
    f.silenceDevice("home");
    await routed(f, "server", LEASE_MS + 1500);
    expect(performance.now() - started).toBeLessThan(LEASE_MS + 1500);
    expect(stream.destroyed).toBe(true);
  }, 20000);
  test("rankings reject duplicates, missing server, invalid IDs and newly unapproved computers", async () => {
    const f = await fixture();
    for (const sourceOrder of [
      [],
      ["home"],
      ["server", "server"],
      ["bad/id", "server"],
      Array.from({ length: 18 }, (_, i) => (i ? `host-${i}` : "server")),
    ]) {
      await expect(rank(f, sourceOrder)).rejects.toThrow();
    }
    await expect(rank(f, ["unapproved", "server"])).rejects.toThrow("sharing");
    await expect(
      f.service.update({
        expectedRevision: 1,
        mode: "server",
        machineId: null,
        sourceOrder: ["unapproved", "server"],
      })
    ).rejects.toThrow("sharing");
    expect(f.getSettings().revision).toBe(1);
  });
});

describe("connected device browser network", () => {
  test("64 simultaneous connections remain independent and the 65th is refused", async () => {
    const f = await fixture();
    f.device("home");
    await f.select("home");
    const streams = await Promise.all(
      Array.from({ length: 64 }, () => f.computer.open("desktop-only.example", 443))
    );
    await expect(f.computer.open("desktop-only.example", 443)).rejects.toThrow("capacity");
    await Promise.all(
      streams.map(async (stream, index) => {
        const payload = Buffer.alloc(64 * 1024, index),
          received: Buffer[] = [];
        const result = new Promise<Buffer>((resolve, reject) => {
          stream.on("data", (data) => received.push(Buffer.from(data)));
          stream.on("end", () => resolve(Buffer.concat(received)));
          stream.on("error", reject);
        });
        stream.end(payload);
        expect((await result).equals(payload)).toBe(true);
      })
    );
    await until(async () => (await f.service.view()).runtime.activeConnections === 0);
  });
  test("a silent but open control channel expires the route and destroys streams without fallback", async () => {
    const f = await fixture();
    f.device("home");
    await f.select("home");
    const stream = await f.computer.open("desktop-only.example", 443);
    f.pauseLeases();
    await until(() => !f.computer.available() && stream.destroyed, 17000);
    await expect(f.computer.open("127.0.0.1", f.port)).rejects.toThrow();
    expect(f.getSettings().mode).toBe("ranked");
  }, 20000);
  test("reconnecting the same selected device restores the route without changing the owner selection", async () => {
    const f = await fixture({ failbackMs: 100 }),
      peer = f.device("home");
    await f.select("home");
    const revision = f.getSettings().revision,
      epoch = f.computer.route!.epoch;
    peer.stop();
    await routed(f, "server");
    f.device("home");
    await until(async () => (await f.service.view()).runtime.state === "ready");
    expect(f.getSettings().revision).toBe(revision);
    expect(f.computer.route!.epoch).not.toBe(epoch);
    expect((await roundTrip(f.computer, Buffer.from("reconnected"))).toString()).toBe(
      "reconnected"
    );
  });
  test("a replacement computer can restart stream IDs while the selected device stays connected", async () => {
    const f = await fixture(),
      peer = f.device("home");
    await f.select("home");
    for (let i = 0; i < 3; i++) await roundTrip(f.computer, Buffer.from("before restart"));
    f.computer.stop();
    const replacement = new BrowserNetworkClient({
      role: "computer",
      url: `ws://127.0.0.1:${f.server.port}/computer`,
      headers: { authorization: "Bearer internal" },
    });
    cleanup.push(() => replacement.stop());
    replacement.start();
    await until(
      async () => replacement.available() && (await f.service.view()).runtime.state === "ready"
    );
    expect(
      (await roundTrip(replacement, Buffer.from("first request after restart"))).toString()
    ).toBe("first request after restart");
    expect(peer.available()).toBe(true);
    expect(f.getSettings().sourceOrder[0]).toBe("home");
  });
  test.skipIf(!browserPath)(
    "real Chromium HTTP/HTTPS, uploads, downloads, WS/WSS and workers use Node proxy and desktop exit",
    async () => {
      const f = await fixture();
      f.computer.stop();
      const directory = await mkdtemp(join(tmpdir(), "openteam-browser-network-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      await writeFile(join(directory, "package.json"), '{"type":"module"}');
      const built = await Bun.build({
        entrypoints: [resolve("packages/plugin-sdk/test/browser-network/peer.fixture.ts")],
        target: "node",
        outdir: directory,
        naming: "peer.js",
      });
      expect(built.success).toBe(true);
      const worker = Bun.spawn(
        [
          process.execPath,
          "build",
          resolve("apps/computer/src/browser-network-worker.ts"),
          "--target",
          "node",
          "--outfile",
          join(directory, "worker.mjs"),
        ],
        { stdout: "ignore", stderr: "inherit" }
      );
      expect(await worker.exited).toBe(0);
      const cert = join(directory, "cert.pem"),
        key = join(directory, "key.pem");
      const ssl = Bun.spawn(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=browser-target.test",
          "-addext",
          "subjectAltName=DNS:browser-target.test,DNS:ipwho.is,DNS:speed.cloudflare.com",
        ],
        { stdout: "ignore", stderr: "ignore" }
      );
      expect(await ssl.exited).toBe(0);
      const start = (file: string, config: unknown) =>
        new Promise<any>((accept, reject) => {
          const child = spawn("node", [join(directory, file)], {
            env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
            stdio: ["pipe", "pipe", "pipe"],
          });
          cleanup.push(() => {
            child.kill();
          });
          if (file === "worker.mjs") child.stdin.write(JSON.stringify(config) + "\n");
          else child.stdin.end(JSON.stringify(config));
          child.stdout.setEncoding("utf8");
          let pending = "";
          const messages: any[] = [];
          child.stdout.on("data", (chunk: string) => {
            pending += chunk;
            let end;
            while ((end = pending.indexOf("\n")) !== -1) {
              const value = JSON.parse(pending.slice(0, end));
              pending = pending.slice(end + 1);
              messages.push(value);
              if (value.started) accept({ ...value, child, messages });
            }
          });
          child.stderr.on("data", () => {});
          child.on("error", reject);
          child.once("exit", (code) => {
            if (code) reject(Error("Network child exited"));
          });
        });
      const computer = await start("worker.mjs", {
        serverUrl: `http://127.0.0.1:${f.server.port}`,
        token: "internal",
        port: 0,
      });
      const credential = f.register("node-device");
      await start("peer.js", {
        url: `ws://127.0.0.1:${f.server.port}/device`,
        headers: {
          authorization: `Bearer ${credential}`,
          "x-openteam-machine-id": "node-device",
          "x-openteam-connection-id": "connection",
        },
        machineId: "node-device",
        deploymentId: f.getSettings().deploymentId,
        cert,
        key,
      });
      await f.select("node-device");
      // The production worker checks the same TLS destination through the real device mux.
      // Only this isolated fixture maps ipwho.is to a local TLS server with a trusted test CA.
      const probeId = crypto.randomUUID();
      computer.child.stdin.write(JSON.stringify({ op: "egress", id: probeId }) + "\n");
      await until(() => computer.messages.some((m: any) => m.id === probeId), 10_000);
      const diagnostic = computer.messages.find((m: any) => m.id === probeId);
      expect(diagnostic.error).toBeUndefined();
      expect(diagnostic.result).toMatchObject({
        sourceId: "node-device",
        ip: "203.0.113.10",
        location: "Device Exit, Fixture",
      });
      expect(await f.service.egress(async () => diagnostic.result)).toEqual(diagnostic.result);
      expect(diagnostic.result.epoch).toBe((await f.service.view()).runtime.routeEpoch);
      const qualityId = crypto.randomUUID();
      computer.child.stdin.write(JSON.stringify({ op: "quality", id: qualityId }) + "\n");
      await until(() => computer.messages.some((m: any) => m.id === qualityId), 10_000);
      const quality = computer.messages.find((m: any) => m.id === qualityId);
      expect(quality.error).toBeUndefined();
      expect(quality.result).toMatchObject({
        sourceId: "node-device",
        epoch: diagnostic.result.epoch,
        downloadBytes: 1048576,
        uploadBytes: 262144,
      });
      expect(quality.result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(quality.result.downloadMbps).toBeGreaterThan(0);
      expect(quality.result.uploadMbps).toBeGreaterThan(0);
      expect(await f.service.egress(async () => quality.result)).toEqual(quality.result);

      const browser = await chromium.launch({
        executablePath: browserPath,
        headless: true,
        args: ["--ignore-certificate-errors", ...managedBrowserNetworkArguments(computer.port)],
      });
      cleanup.push(() => browser.close());
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      let bypassRequests = 0;
      const bypass = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          bypassRequests++;
          return new Response("direct bypass");
        },
      });
      cleanup.push(() => bypass.stop(true));
      for (const scheme of ["http", "https"]) {
        const page = await context.newPage();
        await page.goto(`${scheme}://browser-target.test/`);
        await page.waitForFunction(
          () => {
            const r = (window as any).results;
            return r.api === "device" && r.ws === "through-device";
          },
          undefined,
          { timeout: 8000 }
        );
        const result = await page.evaluate(async () => {
          const upload = await fetch("/upload", {
            method: "POST",
            body: new Uint8Array(1024 * 1024),
          }).then((r) => r.json());
          const downloaded = await fetch("/download").then((r) => r.arrayBuffer());
          return { uploaded: upload.length, downloaded: downloaded.byteLength };
        });
        expect(result).toEqual({ uploaded: 1024 * 1024, downloaded: 4 * 1024 * 1024 });
        if (scheme === "https")
          await page.waitForFunction(() => (window as any).results.worker === true, undefined, {
            timeout: 8000,
          });
        const candidates = await page.evaluate(async () => {
          const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:9" }] });
          const found: string[] = [];
          peer.onicecandidate = (event) => {
            if (event.candidate) found.push(event.candidate.candidate);
          };
          peer.createDataChannel("test");
          await peer.setLocalDescription(await peer.createOffer());
          await new Promise((r) => setTimeout(r, 700));
          peer.close();
          return found;
        });
        expect(candidates).toEqual([]);
        await page.goto(`http://127.0.0.1:${bypass.port}/`).catch(() => {});
        expect(bypassRequests).toBe(0);
        await page.close();
      }
      const largePage = await context.newPage();
      await largePage.goto("https://browser-target.test/");
      const large = await largePage.evaluate(async () => {
        const started = performance.now();
        const reader = (await fetch("/download-large")).body!.getReader();
        let count = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          count += next.value.byteLength;
        }
        return { bytes: count, elapsedMs: Math.round(performance.now() - started) };
      });
      expect(large.bytes).toBe(256 * 1024 * 1024);
      console.log("Browser tunnel large transfer", JSON.stringify(large));
      await largePage.close();
      expect((await f.service.view()).runtime.bytesReceived).toBeGreaterThan(8 * 1024 * 1024);
    },
    60000
  );
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
  test("disconnect interrupts transfers and automatically uses the ranked server", async () => {
    const f = await fixture(),
      device = f.device("home");
    await f.select("home");
    const stream = await f.computer.open("desktop-only.example", 443);
    const revision = f.getSettings().revision;
    device.stop();
    await until(() => stream.destroyed);
    await routed(f, "server");
    expect(f.getSettings().mode).toBe("ranked");
    expect(f.getSettings().revision).toBe(revision);
    expect(f.getSettings().sourceOrder).toEqual(["home", "server"]);
    const direct = await f.computer.open("127.0.0.1", f.port);
    direct.destroy();
    expect(f.getDials()).toBe(1);
  });
  test("switching devices fences every old connection and preserves explicit choice", async () => {
    const f = await fixture();
    f.device("home");
    f.device("office");
    await f.select("home");
    const stream = await f.computer.open("desktop-only.example", 443);
    await f.select("office");
    await until(() => stream.destroyed);
    expect(await roundTrip(f.computer, Buffer.from("new source"))).toEqual(
      Buffer.from("new source")
    );
    expect(f.getSettings().sourceOrder[0]).toBe("office");
  });
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
  test("SOCKS fragmented negotiation reaches the same managed route and rejects UDP", async () => {
    const f = await fixture();
    f.device("home");
    await f.select("home");
    const proxy = createBrowserProxy((host, port) => f.computer.open(host, port));
    const port = await proxy.listen(0);
    cleanup.push(() => proxy.close());
    const socket = createConnection({ host: "127.0.0.1", port });
    cleanup.push(() => socket.destroy());
    socket.on("error", () => {});
    const chunks: Buffer[] = [];
    socket.on("data", (b) => chunks.push(Buffer.from(b)));
    socket.write(Buffer.from([5]));
    await Bun.sleep(5);
    socket.write(Buffer.from([1, 0]));
    await until(() => Buffer.concat(chunks).length >= 2);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([5, 0]));
    chunks.length = 0;
    const host = Buffer.from("desktop-only.example");
    socket.write(
      Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([1, 187])])
    );
    await until(() => Buffer.concat(chunks).length >= 10);
    expect(Buffer.concat(chunks)[1]).toBe(0);
    chunks.length = 0;
    socket.write("hello browser");
    await until(() => Buffer.concat(chunks).length >= 13);
    expect(Buffer.concat(chunks).toString()).toBe("hello browser");
    const udp = createConnection({ host: "127.0.0.1", port });
    cleanup.push(() => udp.destroy());
    const answers: Buffer[] = [];
    udp.on("data", (chunk) => answers.push(Buffer.from(chunk)));
    udp.on("error", () => {});
    udp.write(Buffer.from([5, 1, 0]));
    await until(() => Buffer.concat(answers).length >= 2);
    answers.length = 0;
    udp.write(Buffer.from([5, 3, 0, 1, 127, 0, 0, 1, 0, 80]));
    await until(() => Buffer.concat(answers).length >= 10);
    expect(Buffer.concat(answers)[1]).toBe(7);
  });
});

test("egress diagnostics reject stale epochs, wrong sources and unavailable workers", async () => {
  const f = await fixture();
  await until(async () => (await f.service.view()).runtime.state === "server");
  const epoch = (await f.service.view()).runtime.routeEpoch!;
  const value = {
    epoch,
    sourceId: "server",
    ip: "192.0.2.30",
    location: "Example",
    checkedAt: new Date().toISOString(),
  };
  expect(await f.service.egress(async () => value)).toEqual(value);
  await expect(f.service.egress(async () => ({ ...value, sourceId: "air" }))).rejects.toMatchObject(
    { status: 409 }
  );
  await expect(f.service.egress(async () => ({ ...value, epoch: "old" }))).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    f.service.egress(async () => {
      throw new Error("sensitive upstream detail");
    })
  ).rejects.toMatchObject({ status: 503, message: "Could not check browser exit connection" });
  let complete!: (result: typeof value) => void;
  const inFlight = f.service.egress(
    () =>
      new Promise<typeof value>((resolve) => {
        complete = resolve;
      })
  );
  await until(() => !!complete);
  await f.service.retry();
  complete(value);
  await expect(inFlight).rejects.toMatchObject({ status: 409 });
  f.computer.stop();
  await until(async () => (await f.service.view()).runtime.state === "update_required");
  let called = false;
  await expect(
    f.service.egress(async () => {
      called = true;
      return value;
    })
  ).rejects.toMatchObject({ status: 503 });
  expect(called).toBe(false);
});

test("fresh unsent opens wait for the new exit acknowledgment without replay or premature dialing", async () => {
  const f = await fixture(),
    home = f.device("home"),
    office = f.device("office");
  await until(() => !!home.route && !!office.route);
  await rank(f, ["home", "office", "server"]);
  await routed(f, "home");
  f.delayApplied("office", 350);
  const before = f.getDials();
  home.stop();
  await until(() => !f.computer.available());
  const transfer = roundTrip(f.computer, Buffer.from("new request after sleep"));
  await Bun.sleep(100);
  expect(f.getDials()).toBe(before);
  expect(await transfer).toEqual(Buffer.from("new request after sleep"));
  expect(f.getDials()).toBe(before + 1);
  await routed(f, "office");
});

test("pending transition opens are bounded and cancel when the broker disconnects", async () => {
  const f = await fixture(),
    home = f.device("home"),
    office = f.device("office");
  await until(() => !!home.route && !!office.route);
  await rank(f, ["home", "office", "server"]);
  await routed(f, "home");
  f.delayApplied("office", 500);
  home.stop();
  await until(() => !f.computer.available());
  const waiting = Array.from({ length: 64 }, () => f.computer.open("desktop-only.example", 443));
  const settled = Promise.allSettled(waiting);
  await expect(f.computer.open("desktop-only.example", 443)).rejects.toThrow("capacity");
  f.computer.stop();
  expect((await settled).every((result) => result.status === "rejected")).toBe(true);
});

test("repeated laptop disconnects reach a usable warm fallback without a heartbeat wait", async () => {
  const f = await fixture({ failbackMs: 0 }),
    office = f.device("office");
  await until(() => !!office.route);
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const home = f.device("home");
    await until(() => !!home.route);
    await until(async () => ["ready", "server"].includes((await f.service.view()).runtime.state));
    await rank(f, ["home", "office", "server"]);
    await routed(f, "home");
    const started = performance.now();
    home.stop();
    await routed(f, "office");
    expect(await roundTrip(f.computer, Buffer.from("usable"))).toEqual(Buffer.from("usable"));
    times.push(performance.now() - started);
    await Bun.sleep(700); // Keep the benchmark below the intentional control-frame flood limit.
  }
  const sorted = times.toSorted((a, b) => a - b);
  expect(sorted.at(-1)!).toBeLessThan(1500);
  console.log(
    "FAILOVER_TIMING " +
      JSON.stringify({
        scope: "local authenticated tunnel; not physical sleep or WAN",
        runs: times.length,
        cooldownBetweenRunsMs: 700,
        medianMs: Math.round(sorted[5]!),
        p95Ms: Math.round(sorted.at(-1)!),
      })
  );
}, 15000);

test("a missing route acknowledgment times out unsent opens without dialing or replay", async () => {
  const f = await fixture(),
    home = f.device("home"),
    office = f.device("office");
  await until(() => !!home.route && !!office.route);
  await rank(f, ["home", "office", "server"]);
  await routed(f, "home");
  f.delayApplied("office", Number.POSITIVE_INFINITY);
  const before = f.getDials();
  home.stop();
  await until(() => !f.computer.available());
  const started = performance.now();
  await expect(f.computer.open("desktop-only.example", 443)).rejects.toThrow("device_unavailable");
  expect(performance.now() - started).toBeLessThan(2300);
  expect(f.getDials()).toBe(before);
  f.delayApplied("office", 0);
  await routed(f, "office");
  expect(f.getDials()).toBe(before);
}, 10000);

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
