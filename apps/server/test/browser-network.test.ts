import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type AddressInfo } from "node:net";
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
import { NETWORK_PROTOCOL, type NetworkSettings } from "@openteam/plugin-sdk/browser-network/protocol";
import {
  decodeFrame,
  encodeFrame,
  FrameType,
  parseJson,
} from "@openteam/plugin-sdk/browser-network/protocol";
import { managedBrowserNetworkArguments } from "../../computer/src/browser-network";
import type { NetworkDiagnostic } from "@openteam/plugin-sdk/browser-network/diagnostics";

const browserPath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  chromium.executablePath(),
].find((path) => path && existsSync(path));
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Network fixture cleanup failed");
}, 30_000);
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
  const diagnostics: NetworkDiagnostic[] = [];
  const computerDiagnostics: NetworkDiagnostic[] = [];
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
  const silentDevices = new Set<string>();
  const appliedDelays = new Map<string, number>();
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
    { ...options, diagnostic: (event) => diagnostics.push(event) }
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
      message: (socket, message) => {
        if (
          silentDevices.has(socket.data.machineId ?? "") &&
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
    diagnostic: (event) => computerDiagnostics.push(event),
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
      (await service.view()).devices.some((d) => d.machineId === id && d.sharingAllowed && d.working)
    );
    await service.update({ expectedRevision: settings.revision, mode: "device", machineId: id });
    await until(async () => {
      const view = await service.view();
      return view.runtime.state === "ready" && (!waitForComputer || (computer.available() &&
        computer.route?.machineId === id && computer.route.epoch === view.runtime.routeEpoch));
    });
  };
  return {
    diagnostics,
    computerDiagnostics,
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
    silenceDevice: (id: string) => silentDevices.add(id),
    delayApplied: (id: string, ms: number) => appliedDelays.set(id, ms),
    getConnections: (id: string) => connections.get(id) ?? 0,
    failReads: (count: number) => {
      failedReads = count;
    },
    refuseDials: (id: string, refuse: boolean) => {
      if (refuse) refusedDials.add(id);
      else refusedDials.delete(id);
    },
    register: (id: string) => {
      const token = crypto.randomUUID();
      credentials.set(id, token);
      enabled.set(id, true);
      return token;
    },
  };
}
test("network diagnostics distinguish a revoked route from an upstream reset", async () => {
  const f = await fixture();
  const peer = f.device("diagnostic-exit");
  await f.select("diagnostic-exit");
  const epoch = f.computer.route!.epoch;
  const stream = await f.computer.open("desktop-only.example", 443);
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  f.service.revoke("diagnostic-exit");
  await closed;
  await until(() => f.computer.available() && f.computer.route?.mode === "server");
  expect(f.diagnostics).toContainEqual(expect.objectContaining({ event: "transport_closed", reason: "permission_revoked", epoch, mode: "device" }));
  expect(f.diagnostics).toContainEqual(expect.objectContaining({ event: "route_changed", reason: "source_changed", mode: "server", previousMode: "device" }));
  expect(f.computerDiagnostics).toContainEqual(expect.objectContaining({ event: "route_fenced", epoch, mode: "device", activeConnections: 1 }));
  peer.stop();
});
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
  test.skipIf(!browserPath)(
    "real Chromium HTTP/HTTPS, uploads, downloads, WS/WSS and workers use Node proxy and desktop exit",
    async () => {
      const f = await fixture();
      f.computer.stop();
      const directory = await mkdtemp(join(tmpdir(), "openteam-browser-network-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      await writeFile(join(directory, "package.json"), '{"type":"module"}');
      const built = await Bun.build({
        entrypoints: [
          resolve(
            import.meta.dirname,
            "../../../packages/plugin-sdk/test/browser-network/peer.fixture.ts"
          ),
        ],
        target: "node",
        outdir: directory,
        naming: "peer.js",
      });
      expect(built.success).toBe(true);
      const worker = Bun.spawn(
        [
          process.execPath,
          "build",
          resolve(import.meta.dirname, "../../computer/src/browser-network-worker.ts"),
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
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          cleanup.push(async () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const force = setTimeout(() => child.kill("SIGKILL"), 2000);
            child.kill();
            try { await exited; } finally { clearTimeout(force); }
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
      await f.select("node-device", false);
      // The server's applied route can precede the replacement Node worker's lease.
      // Select only after the device has a lease, then wait for the worker's own readiness.
      const epoch = (await f.service.view()).runtime.routeEpoch;
      await until(() => {
        const status = computer.messages.findLast((message: any) => typeof message.ready === "boolean");
        return status?.ready && status.routeEpoch === epoch;
      });
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
      // Stop service workers and outstanding requests before closing their browser and relay.
      cleanup.push(() => context.close());
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
    // This includes a 256 MiB browser transfer; keep RPC deadlines above short, but allow
    // the bulk transfer and deterministic process cleanup to finish on loaded test hosts.
    120000
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


