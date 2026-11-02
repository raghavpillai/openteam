import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { chromium } from "playwright-core";
import WebSocket from "ws";

const config = JSON.parse(await readFile("/tmp/network-test-config.json", "utf8"));
const phase = process.argv[2] ?? "initial";
const server = "http://server:8787";
let token = "";
let checks = 0;
function pass(name: string) {
  checks++;
  console.log(`PASS ${name}`);
}
async function until(check: () => unknown | Promise<unknown>, label: string, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {
      /* A restarting component is expected to be temporarily unavailable. */
    }
    await Bun.sleep(100);
  }
  throw Error(`Timed out: ${label}`);
}
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${server}/api/v0${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(path.endsWith("/quality") ? 25000 : 10000),
  });
  if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
const view = () => api("/server-settings/browser-network");
async function device(name: "device-a" | "device-b", path = "/", body?: unknown) {
  const response = await fetch(`http://${name}:8888${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `${name} ${path}: ${await response.clone().text()}`);
  return response.json() as Promise<any>;
}
async function select(mode: "server" | "device", machineId: string | null = null) {
  const current = await view();
  await api("/server-settings/browser-network", "PATCH", {
    expectedRevision: current.settings.revision,
    mode: "ranked",
    machineId: null,
    sourceOrder: [
      mode === "server" ? "server" : machineId!,
      ...current.settings.sourceOrder.filter(
        (id: string) => id !== (mode === "server" ? "server" : machineId)
      ),
    ],
  });
  await until(
    async () => (await view()).runtime.state === (mode === "server" ? "server" : "ready"),
    "route ready"
  );
}
async function computer(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`http://127.0.0.1:8790${path}`, {
    method,
    headers: { authorization: `Bearer ${config.control}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<any>;
}
if (phase !== "chaos-relay")
  await until(
    async () => (await fetch(`${server}/api/v0/auth/config`)).ok,
    "server startup",
    90000
  );
const stateFile = "/tmp/network-test-state.json";
if (phase === "initial") {
  const login = await fetch(`${server}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "network_test", password: config.password }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  token = login.headers.get("set-auth-token")!;
  assert.ok(token);
  await writeFile(stateFile, JSON.stringify({ token }), { mode: 0o600 });
} else token = JSON.parse(await readFile(stateFile, "utf8")).token;
if (phase !== "chaos-relay")
  await until(async () => (await computer("/v1/browser-network")).ready, "computer network worker");

// These are headed browsers created by the actual image's ScreenBroker, running as box UID 1000.
const browsers: Awaited<ReturnType<typeof chromium.connectOverCDP>>[] = [];
const pages: any[] = [];
for (let i = 0; i < 2; i++) {
  const screenStarted = performance.now();
  const screen = await computer(`/v1/screens/${config.bots[i]}?cwd=/workspace`);
  assert.equal(screen.state, "ready", screen.error);
  if (phase === "chaos-relay")
    assert.ok(
      performance.now() - screenStarted < 1000,
      "cached screen controls blocked on the frozen server"
    );
  await computer(`/v1/screens/${config.bots[i]}/actions`, "POST", {
    cwd: "/workspace",
    input: { action: "open_app", app: "chromium" },
  });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${9300 + i}`);
  browsers.push(browser);
  const page = await browser.contexts()[0]!.newPage();
  page.setDefaultTimeout(10000);
  pages.push(page);
}
// CDP attaches from the root test driver to runner-owned Chromium. Playwright's
// temporary download directory otherwise has root-only permissions.
for (const name of await readdir("/tmp"))
  if (name.startsWith("playwright-artifacts-")) await chmod(`/tmp/${name}`, 0o777);
async function origin(page = pages[0], scheme = "https") {
  await page.goto(`${scheme}://browser-target.test/?nonce=${crypto.randomUUID()}`, {
    waitUntil: "load",
    timeout: 15000,
  });
  await page.waitForFunction(
    () => (window as any).results.ws === "device-echo" && !!(window as any).results.worker
  );
  return page.evaluate(() => (window as any).results.api) as Promise<string>;
}
async function blocked(url: string) {
  const page = await browsers[0]!.contexts()[0]!.newPage();
  let failed = false;
  try {
    await page.goto(url, { timeout: 4000 });
  } catch {
    failed = true;
  }
  await page.close();
  assert.ok(failed, `Request unexpectedly succeeded: ${url}`);
}
async function waitDevice(id: string) {
  await until(
    async () => (await view()).devices.some((d: any) => d.machineId === id && d.sharingAllowed),
    "device consent online"
  );
}
async function rankConnections(sourceOrder: string[]) {
  const current = await view();
  await api("/server-settings/browser-network", "PATCH", {
    expectedRevision: current.settings.revision,
    mode: "ranked",
    machineId: null,
    sourceOrder,
  });
}
async function rankedSource(source: string, timeout = 25000) {
  await until(
    async () => {
      const current = await view(),
        status = await computer("/v1/browser-network");
      return (
        status.ready &&
        status.mode === (source === "server" ? "server" : "device") &&
        (source === "server"
          ? current.runtime.state === "server"
          : current.runtime.state === "ready" && current.runtime.activeMachineId === source)
      );
    },
    "ranked route ready",
    timeout
  );
}
async function interruptedBy(action: () => Promise<unknown>, label: string) {
  await origin();
  const inflight = pages[0].evaluate(async () => {
    try {
      const reader = (await fetch("/slow")).body!.getReader();
      let bytes = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) return { completed: true, bytes };
        bytes += next.value.length;
      }
    } catch {
      return { completed: false };
    }
  });
  await Bun.sleep(200);
  await action();
  assert.equal((await inflight).completed, false, label);
  pass(label);
}
try {
  if (phase === "initial") {
    assert.equal((await fetch(`${server}/api/v0/server-settings/browser-network`)).status, 401);
    const denied = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(
        "ws://server:8787/api/v0/internal/browser-network/channel",
        "openteam-browser-network.v1",
        { headers: { authorization: "Bearer wrong" } }
      );
      ws.on("unexpected-response", (_req, response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      ws.on("open", () => {
        ws.close();
        reject(Error("unauthorized WebSocket accepted"));
      });
      ws.on("error", () => {});
    });
    assert.equal(denied, 401);
    pass("real owner HTTP and computer WebSocket authentication");
    for (const name of ["device-a", "device-b"] as const) await device(name, "/start", { token });
    await until(
      async () =>
        (await device("device-a")).network.connected &&
        (await device("device-b")).network.connected,
      "real desktop enrollment and identity"
    );
    assert.equal((await device("device-a")).network.sharingAllowed, false);
    const initial = await view();
    const unapproved = await fetch(`${server}/api/v0/server-settings/browser-network`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: initial.settings.revision,
        mode: "device",
        machineId: config.a,
      }),
    });
    assert.equal(unapproved.status, 409);
    pass("enrolled devices default to no consent and cannot be selected");
    for (const name of ["device-a", "device-b"] as const)
      await device(name, "/share", { enabled: true });
    await waitDevice(config.a);
    await waitDevice(config.b);
    await until(
      async () =>
        (await view()).settings.sourceOrder.includes(config.a) &&
        (await view()).settings.sourceOrder.includes(config.b),
      "consented devices automatically enter ranking"
    );
    const automatic = await view();
    assert.equal(automatic.settings.mode, "ranked");
    assert.deepEqual(
      new Set(automatic.settings.sourceOrder),
      new Set([config.a, config.b, "server"])
    );
    assert.equal(automatic.settings.sourceOrder.at(-1), "server");
    pass("local consent automatically registers both desktop providers in the saved priority pool");
    await select("device", config.a);
    assert.ok(
      !(await lookup("browser-target.test").catch(() => null)),
      "computer must not resolve the device-only hostname"
    );
    let direct = false;
    try {
      direct = (await fetch("http://11.77.0.80/api", { signal: AbortSignal.timeout(1000) })).ok;
    } catch {}
    assert.equal(direct, false, "computer must not reach isolated target network");
    pass("computer has neither target DNS nor a direct network path");
    const diagnostic = await api("/server-settings/browser-network/egress", "POST", {});
    assert.equal(diagnostic.ip, "11.77.0.11");
    assert.equal(diagnostic.sourceId, config.a);
    const quality = await api("/server-settings/browser-network/quality", "POST", {});
    assert.equal(quality.sourceId, config.a);
    assert.equal(quality.epoch, (await view()).runtime.routeEpoch);
    assert.equal(quality.downloadBytes, 1048576);
    assert.equal(quality.uploadBytes, 262144);
    assert.ok(Number.isFinite(quality.latencyMs) && quality.latencyMs >= 0);
    assert.ok(quality.downloadMbps > 0 && quality.uploadMbps > 0);
    const diagnosticStats = await device("device-a", "/target-stats");
    assert.ok(diagnosticStats.queries.some((q: any) => q.name === "speed.cloudflare.com"));
    assert.ok(
      diagnosticStats.requests.some((r: any) => r.path === "/__down" && r.ip === "11.77.0.11")
    );
    assert.ok(
      diagnosticStats.requests.some((r: any) => r.path === "/__up" && r.ip === "11.77.0.11")
    );
    pass(
      "production Node worker IP and latency/download/upload diagnostics use verified TLS, device DNS and device A exit"
    );

    for (const page of pages)
      for (const scheme of ["http", "https"])
        assert.equal(await origin(page, scheme), "11.77.0.11");
    await pages[0].waitForFunction(() => (window as any).results.serviceWorker === true);
    const stats = await device("device-a", "/target-stats");
    for (const path of [
      "/",
      "/api",
      "/iframe",
      "/script.js",
      "/style.css",
      "/image.svg",
      "/worker.js",
      "/sw.js",
    ])
      assert.ok(
        stats.requests.some((r: any) => r.path === path && r.ip === "11.77.0.11"),
        path
      );
    assert.ok(stats.queries.some((q: any) => q.name === "browser-target.test"));
    pass(
      "two managed bot browsers: HTTP/TLS, DNS, subresources, iframe, fetch, workers and WS/WSS all exit device A"
    );
    const payload = randomBytes(1024 * 1024);
    await pages[0].locator("#upload").setInputFiles({
      name: "payload.bin",
      mimeType: "application/octet-stream",
      buffer: payload,
    });
    const upload = await pages[0].evaluate(async () => {
      const file = (document.querySelector("#upload") as HTMLInputElement).files![0];
      return (await fetch("/upload", { method: "POST", body: file })).json();
    });
    assert.equal(upload.bytes, payload.length);
    assert.equal(upload.hash, createHash("sha256").update(payload).digest("hex"));
    const downloadEvent = pages[0].waitForEvent("download");
    await pages[0].locator("#download").click();
    const download = await downloadEvent;
    await download.saveAs("/tmp/network-native-download.bin");
    const downloaded = await readFile("/tmp/network-native-download.bin");
    assert.equal(downloaded.length, 4 * 1024 * 1024);
    assert.ok(downloaded.every((b) => b === 0x5a));
    pass("native file input upload and browser download preserve exact bytes");
    const large = await pages[0].evaluate(async () => {
      const start = performance.now(),
        reader = (await fetch("/large")).body!.getReader();
      let bytes = 0,
        valid = true;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        valid &&= next.value.every((b) => b === 0x5a);
      }
      return { bytes, valid, elapsedMs: Math.round(performance.now() - start) };
    });
    assert.equal(large.bytes, 256 * 1024 * 1024);
    assert.equal(large.valid, true);
    console.log("TRANSFER", JSON.stringify(large));
    pass("256 MiB TLS streaming download validates every byte");
    for (const url of [
      "http://127.0.0.1:8790/",
      "http://169.254.169.254/",
      "http://server:8787/",
      "http://browser-target.test:8080/",
      "http://mixed-target.test/",
    ])
      await blocked(url);
    assert.ok(
      !(await device("device-a", "/target-stats")).requests.some(
        (r: any) => r.path === "FORBIDDEN_PORT"
      )
    );
    pass(
      "loopback bypass, metadata, private service, forbidden port and mixed DNS answers blocked"
    );
    const candidates = await pages[0].evaluate(async () => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:11.77.0.80:3478" }] });
      const found: string[] = [];
      peer.onicecandidate = (e) => {
        if (e.candidate) found.push(e.candidate.candidate);
      };
      peer.createDataChannel("probe");
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((r) => setTimeout(r, 1000));
      peer.close();
      return found;
    });
    assert.deepEqual(candidates, []);
    pass("managed Linux Chromium produces no direct WebRTC UDP candidates");
    await interruptedBy(
      () => select("device", config.b),
      "switching device interrupts an in-flight download"
    );
    const switchedExit = await api("/server-settings/browser-network/egress", "POST", {});
    const immediateQuality = await api("/server-settings/browser-network/quality", "POST", {});
    assert.equal(switchedExit.ip, "11.77.0.12");
    assert.equal(switchedExit.sourceId, config.b);
    assert.equal(immediateQuality.sourceId, config.b);
    assert.equal(immediateQuality.epoch, switchedExit.epoch);
    pass(
      "IP and speed checks immediately follow the new exit without a stale status snapshot or cached old source"
    );
    for (const page of pages) assert.equal(await origin(page), "11.77.0.12");
    pass("existing bot browsers both follow explicit device B selection");
    await interruptedBy(
      () => device("device-b", "/share", { enabled: false }),
      "local Stop sharing immediately interrupts streams"
    );
    await rankedSource(config.a);
    assert.equal((await view()).settings.sourceOrder[0], config.b);
    assert.equal(await origin(), "11.77.0.11");
    assert.equal((await fetch(`${server}/api/v0/auth/config`)).status, 200);
    pass(
      "revocation retains priority and falls back to the next computer; ordinary computer fetch is unaffected"
    );
    await device("device-b", "/share", { enabled: true });
    await rankedSource(config.b, 45000);
    assert.equal(await origin(), "11.77.0.12");
    const revision = (await view()).settings.revision;
    await interruptedBy(
      () => device("device-b", "/stop", {}),
      "desktop disconnect interrupts streams"
    );
    await device("device-b", "/start", {});
    await rankedSource(config.b, 45000);
    assert.equal((await view()).settings.revision, revision);
    assert.equal(await origin(), "11.77.0.12");
    pass("same device re-enrolls with saved consent and reclaims its rank after stable return");
    await interruptedBy(
      () => device("device-b", "/suspend", { suspended: true }),
      "device suspend fences active sockets"
    );
    await device("device-b", "/suspend", { suspended: false });
    await rankedSource(config.b, 45000);
    assert.equal(await origin(), "11.77.0.12");
    pass("resume restores the selected device");
    await interruptedBy(
      () => api(`/server-settings/machines/${config.b}`, "PATCH", { enabled: false }),
      "server-side machine disable revokes active route"
    );
    await rankedSource(config.a);
    assert.equal(await origin(), "11.77.0.11");
    await api(`/server-settings/machines/${config.b}`, "PATCH", { enabled: true });
    await rankedSource(config.b, 45000);
    assert.equal(await origin(), "11.77.0.12");
    await select("server");
    await pages[0].goto(`${server}/api/v0/auth/config`);
    assert.match(await pages[0].textContent("body"), /required/);
    pass("explicit server switch restores computer-side private reachability");
    await select("device", config.b);
    const workerPids = async () => {
      const found: number[] = [];
      for (const name of await readdir("/proc"))
        if (/^\d+$/.test(name)) {
          const cmd = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
          if (cmd.startsWith("/usr/bin/node\0") && cmd.includes("browser-network-worker.mjs"))
            found.push(Number(name));
        }
      return found;
    };
    const before = await workerPids();
    assert.equal(before.length, 1);
    await interruptedBy(async () => {
      process.kill(before[0]!, "SIGKILL");
    }, "computer Node worker crash interrupts streams");
    await until(
      async () =>
        (await workerPids()).some((pid) => pid !== before[0]) &&
        (await computer("/v1/browser-network")).ready &&
        (await view()).runtime.state === "ready",
      "worker supervision recovery"
    );
    assert.equal(await origin(), "11.77.0.12");
    pass("supervisor restarts worker and restores selected source");
    const soakStart = Date.now();
    let iterations = 0;
    while (Date.now() - soakStart < 60000) {
      const values = await Promise.all(
        pages.map((page) =>
          page.evaluate(async () => (await fetch(`/api?nonce=${Math.random()}`)).json())
        )
      );
      assert.ok(values.every((v) => v.ip === "11.77.0.12"));
      iterations++;
      await Bun.sleep(200);
    }
    console.log("SOAK", JSON.stringify({ seconds: 60, iterations, requests: iterations * 2 }));
    pass("one-minute simultaneous bot browser soak spans multiple lease renewals");
    const switchedDiagnostic = await api("/server-settings/browser-network/egress", "POST", {});
    const switchedQuality = await api("/server-settings/browser-network/quality", "POST", {});
    assert.equal(switchedDiagnostic.ip, "11.77.0.12");
    assert.equal(switchedQuality.sourceId, config.b);
    assert.equal(switchedQuality.epoch, (await view()).runtime.routeEpoch);
    pass(
      "IP and quality diagnostics follow the new active exit after switching and worker restart"
    );

    await pages[0].screenshot({ path: "/tmp/network-linux-browser.png" });
    await writeFile(
      stateFile,
      JSON.stringify({ token, revision: (await view()).settings.revision }),
      { mode: 0o600 }
    );
  } else if (phase === "ranking") {
    const beforeRank = await view();
    const deniedRank = await fetch(`${server}/api/v0/server-settings/browser-network`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: beforeRank.settings.revision,
        mode: "server",
        machineId: null,
        sourceOrder: [crypto.randomUUID(), "server"],
      }),
    });
    assert.equal(deniedRank.status, 409);
    assert.equal((await view()).settings.revision, beforeRank.settings.revision);
    pass("owner API rejects staging an unapproved computer through manual mode");
    await rankConnections([config.a, config.b, "server"]);
    await rankedSource(config.a);
    for (const page of pages) assert.equal(await origin(page), "11.77.0.11");
    const revision = (await view()).settings.revision;
    pass("ranked preference selects device A for both managed browsers");
    await interruptedBy(
      () => device("device-a", "/share", { enabled: false }),
      "ranked device loss interrupts transfers without replay"
    );
    await rankedSource(config.b);
    for (const page of pages) assert.equal(await origin(page), "11.77.0.12");
    assert.equal((await view()).settings.revision, revision);
    pass(
      "local revoke automatically falls through to ranked device B without rewriting preferences"
    );
    await interruptedBy(
      () => device("device-b", "/share", { enabled: false }),
      "loss of the last ranked computer interrupts its active transfer"
    );
    await rankedSource("server");
    await pages[0].goto(`${server}/api/v0/auth/config`);
    assert.match(await pages[0].textContent("body"), /required/);
    pass("all ranked computers offline automatically uses the listed server connection");
    await rankConnections([config.a, "server", config.b]);
    await device("device-b", "/share", { enabled: true });
    await waitDevice(config.b);
    await Bun.sleep(1000);
    await rankedSource("server");
    assert.equal((await view()).runtime.activeMachineId, null);
    pass("a computer below the server does not override server priority");
    await device("device-a", "/share", { enabled: true });
    await waitDevice(config.a);
    await rankConnections(["server", config.b, config.a]);
    await rankedSource("server");
    assert.equal((await view()).runtime.activeMachineId, null);
    pass("explicitly ranking the server first keeps both approved computers on standby");
    await rankConnections([config.b, config.a, "server"]);
    await rankedSource(config.b);
    const currentRevision = (await view()).settings.revision;
    await interruptedBy(
      () => device("device-b", "/share", { enabled: false }),
      "ranked primary revoke fences the old route"
    );
    await rankedSource(config.a);
    assert.equal(await origin(), "11.77.0.11");
    pass("new ranking chooses device A as the second-choice exit");
    await device("device-b", "/share", { enabled: true });
    await waitDevice(config.b);
    await Bun.sleep(1000);
    assert.equal((await view()).runtime.activeMachineId, config.a);
    pass("a returning preferred computer does not immediately preempt its healthy fallback");
    await rankedSource(config.b, 45000);
    for (const page of pages) assert.equal(await origin(page), "11.77.0.12");
    assert.equal((await view()).settings.revision, currentRevision);
    pass("the preferred computer reclaims the route after 30 seconds of continuous availability");
    await writeFile(
      stateFile,
      JSON.stringify({
        token,
        revision: currentRevision,
        sourceOrder: [config.b, config.a, "server"],
      }),
      { mode: 0o600 }
    );
  } else if (phase === "chaos-loss") {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    await rankedSource(config.b, 60000);
    for (const page of pages) {
      assert.equal(await origin(page), "11.77.0.12");
      const payload = randomBytes(64 * 1024),
        expected = createHash("sha256").update(payload).digest("hex");
      const results = await page.evaluate(
        async ({ body, prefix }: { body: number[]; prefix: string }) => {
          return Promise.all(
            Array.from({ length: 4 }, async (_, i) => {
              const response = await fetch("/upload", {
                method: "POST",
                headers: { "x-chaos-id": `${prefix}-${i}` },
                body: new Uint8Array(body),
                signal: AbortSignal.timeout(25000),
              });
              if (!response.ok) throw Error(`Upload failed ${response.status}`);
              return response.json();
            })
          );
        },
        { body: [...payload], prefix: crypto.randomUUID() }
      );
      for (const result of results) {
        assert.equal(result.bytes, payload.length);
        assert.equal(result.hash, expected);
        assert.equal(result.deliveries, 1);
        assert.equal(result.ip, "11.77.0.12");
      }
    }
    assert.equal((await view()).settings.revision, saved.revision);
    pass(
      "80 ms delay, 20 ms jitter and seeded 2% packet loss preserve exact upload bytes and single delivery across both browsers"
    );
  } else if (phase === "chaos-identity") {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    const before = await device("device-b");
    const outage = await device("device-b", "/identity-outage", {});
    assert.equal(outage.network.connected, false);
    assert.equal(outage.network.sharingAllowed, false);
    assert.equal(outage.identityFaults, before.identityFaults + 1);
    await rankedSource(config.a, 9000);
    for (const page of pages) assert.equal(await origin(page), "11.77.0.11");
    await until(async () => {
      const current = await device("device-b");
      return (
        current.network.connected &&
        current.network.sharingAllowed &&
        current.identityRequests >= before.identityRequests + 2
      );
    }, "identity retry with saved consent");
    await rankedSource(config.b, 60000);
    for (const page of pages) assert.equal(await origin(page), "11.77.0.12");
    assert.equal((await view()).settings.revision, saved.revision);
    assert.deepEqual((await view()).settings.sourceOrder, saved.sourceOrder);
    pass(
      "a transient identity outage falls back, retries with saved consent, and restores both browsers without an owner edit"
    );
  } else if (phase === "chaos-relay") {
    await until(
      async () => !(await computer("/v1/browser-network")).ready,
      "relay lease expiry",
      9000
    );
    await blocked("https://browser-target.test/api");
    pass(
      "a frozen relay retains responsive screen controls, expires browser leases and fails closed instead of dialing directly"
    );
  } else if (phase === "chaos-all-offline") {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    await rankedSource("server", 9000);
    for (const page of pages) {
      await page.goto(`${server}/api/v0/auth/config`);
      assert.match(await page.textContent("body"), /required/);
    }
    assert.equal((await view()).settings.revision, saved.revision);
    pass(
      "simultaneous silent loss of both providers falls through to the ranked server without rewriting priority"
    );
  } else if (phase === "blackhole" || phase === "chaos-link-down") {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    await rankedSource(config.a, 9000);
    for (const page of pages) assert.equal(await origin(page), "11.77.0.11");
    assert.equal((await view()).settings.revision, saved.revision);
    const elapsedMs = Date.now() - Number(process.env.TEST_BLACKHOLE_STARTED_AT);
    assert.ok(
      elapsedMs < 11000,
      `Frozen-provider detection and browser recovery took ${elapsedMs}ms`
    );
    console.log(
      phase === "chaos-link-down" ? "LINK_CHANGE_TIMING" : "BLACKHOLE_TIMING",
      JSON.stringify({
        elapsedMs,
        scope:
          phase === "chaos-link-down"
            ? "Kernel eth0 link-down on selected provider; includes test startup and two browser navigations"
            : "Docker-pause freezes provider without notifying the server; includes test startup and two browser navigations",
      })
    );
    pass(
      phase === "chaos-link-down"
        ? "kernel link-down falls through to device A and both browsers without rewriting priorities"
        : "a frozen laptop provider falls through to device A on the six-second lease without socket-close notification"
    );
  } else {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    await rankedSource(config.b, 60000);
    assert.equal((await view()).settings.mode, "ranked");
    assert.deepEqual((await view()).settings.sourceOrder, saved.sourceOrder);
    assert.equal((await view()).settings.revision, saved.revision);
    for (const page of pages) assert.equal(await origin(page), "11.77.0.12");
    pass(`${phase}: persisted selection, consent, enrollment and both managed browsers recover`);
    if (phase === "finish") {
      await interruptedBy(async () => {
        const response = await fetch(`${server}/api/auth/sign-out`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(response.status, 200);
      }, "owner sign-out revokes the real enrolled device session and active sockets");
      await until(async () => {
        const status = await computer("/v1/browser-network");
        return status.ready && status.mode === "server";
      }, "ranked server fallback after sign-out");
      await pages[0].goto(`${server}/api/v0/auth/config`);
      assert.match(await pages[0].textContent("body"), /required/);
      assert.equal(
        (
          await fetch(`${server}/api/v0/server-settings/browser-network`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
        401
      );
      pass("revoked owner token is rejected; the explicitly ranked server provides fallback");
    }
  }
  console.log(
    `RESULT ${JSON.stringify({ phase, checks, platform: process.platform, arch: process.arch, bun: Bun.version })}`
  );
} finally {
  for (const page of pages) await page.close().catch(() => {});
  for (const browser of browsers) browser.close().catch(() => {});
}
