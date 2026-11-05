/** Uses a fresh temporary Chromium profile and a loopback-only fixture login. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { clearStoppedBrowserCaches } from "../src/browser/cache-maintenance";

const executable = process.env.OPENTEAM_TEST_CHROMIUM_EXECUTABLE;
if (!executable) throw new Error("Set OPENTEAM_TEST_CHROMIUM_EXECUTABLE to a Chromium executable");
const root = realpathSync(mkdtempSync(join(tmpdir(), "openteam-browser-preservation-")));
const profile = join(root, "profile");
const server = createServer((request, response) => {
  if (request.url === "/login")
    response.setHeader(
      "Set-Cookie",
      "fixture_login=retained; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/"
    );
  if (request.url === "/private") {
    response.writeHead(request.headers.cookie?.includes("fixture_login=retained") ? 200 : 401);
    response.end("fixture account");
  } else if (request.url === "/sw.js") {
    response.setHeader("Content-Type", "application/javascript");
    response.end(
      "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));"
    );
  } else if (request.url === "/cached.js") {
    response.setHeader("Content-Type", "application/javascript");
    response.setHeader("Cache-Control", "public, max-age=31536000");
    response.end(`window.fixtureCached = true;\n${"// cached fixture asset\n".repeat(8000)}`);
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><title>Local preservation fixture</title><script src="/cached.js"></script>'
    );
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
let child: ChildProcess | undefined;
const start = async () => {
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  const process = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disk-cache-size=134217728",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  child = process;
  let spawnError: Error | undefined;
  process.once("error", (error) => {
    spawnError = error;
  });
  const file = join(profile, "DevToolsActivePort");
  for (let attempt = 0; !existsSync(file); attempt++) {
    if (spawnError) throw spawnError;
    assert(attempt < 1000 && process.exitCode === null, "fixture Chromium did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const port = readFileSync(file, "utf8").split("\n")[0];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, context, page, process };
};
const close = async (running: Awaited<ReturnType<typeof start>>) => {
  const exited = new Promise<void>((resolve) => running.process.once("exit", () => resolve()));
  const session = await running.browser.newBrowserCDPSession();
  await session.send("Browser.close");
  await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Chromium shutdown timed out")), 15_000).unref()
    ),
  ]);
  assert.equal(running.process.exitCode, 0, "fixture requires a real clean exit");
  assert.equal(running.process.signalCode, null);
};
const protectedFiles = () => {
  const hashes = new Map<string, string>();
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else hashes.set(path, createHash("sha256").update(readFileSync(path)).digest("hex"));
  };
  for (const entry of [
    "Local State",
    "Default/Cookies",
    "Default/Network",
    "Default/Login Data",
    "Default/Local Storage",
    "Default/Session Storage",
    "Default/IndexedDB",
    "Default/Service Worker",
    "Default/Sessions",
    "Default/History",
    "Default/Preferences",
  ])
    visit(join(profile, entry));
  return hashes;
};
try {
  const first = await start();
  await first.page.goto(`${origin}/login`);
  await first.page.evaluate(async () => {
    localStorage.setItem("fixture_state", "preserved");
    sessionStorage.setItem("fixture_tab", "preserved");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("fixture", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("state", "readwrite");
        tx.objectStore("state").put("preserved", "login-state");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const cache = await caches.open("fixture-offline-state");
    await cache.put("/fixture-offline", new Response("preserved"));
  });
  assert.equal((await first.page.request.get(`${origin}/private`)).status(), 200);
  const liveFiles = protectedFiles();
  assert.deepEqual(
    clearStoppedBrowserCaches(profile, first.process),
    [],
    "live profile must be skipped"
  );
  await close(first);
  const before = protectedFiles();
  assert(before.size > 10 && liveFiles.size > 0, "real browser state was not written");
  const removed = clearStoppedBrowserCaches(profile, first.process);
  assert(removed.length > 0, "no actual browser cache was removed");
  assert.deepEqual(protectedFiles(), before, "cleanup changed protected browser-state bytes");
  const second = await start();
  await second.page.goto(origin);
  assert.equal(
    (await second.page.request.get(`${origin}/private`)).status(),
    200,
    "login cookie did not survive restart"
  );
  const state = await second.page.evaluate(async () => ({
    local: localStorage.getItem("fixture_state"),
    indexed: await new Promise((resolve) => {
      const request = indexedDB.open("fixture", 1);
      request.onsuccess = () => {
        const db = request.result;
        const get = db.transaction("state").objectStore("state").get("login-state");
        get.onsuccess = () => {
          const value = get.result;
          db.close();
          resolve(value);
        };
      };
    }),
    offline: await (await caches.match("/fixture-offline"))?.text(),
    worker: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  assert.deepEqual(state, {
    local: "preserved",
    indexed: "preserved",
    offline: "preserved",
    worker: 1,
  });
  await close(second);
  console.log(
    `PASS: real Chromium clean exit/cache removal/restart; authenticated cookie, IndexedDB, local storage, service worker and offline site cache retained; ${before.size} protected files byte-identical`
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
