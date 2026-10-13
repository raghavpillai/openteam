/** Opt-in integration test. Creates an isolated Docker project and temporary private
 * Serve routes, then removes only those resources. Requires host Tailscale HTTPS. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  createEnvironment,
  installationPaths,
  parseEnvironment,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import { SystemCommandRunner } from "../src/process";
import { configureTailscale, tailscaleStatus } from "../src/tailscale-command";
import { cleanManagedTailscaleRoutes, managedTailscaleRoutes } from "../src/tailscale-state";
import { readTailscaleServe, requireTailscale } from "../src/tailscale-https";
import { requireComposeProject } from "../src/docker";

if (process.env.OPENTEAM_TAILSCALE_LIVE_TEST !== "1")
  throw new Error(
    "Set OPENTEAM_TAILSCALE_LIVE_TEST=1 to create temporary Docker services and Tailscale routes."
  );
const image = process.env.OPENTEAM_TAILSCALE_TEST_IMAGE || "oven/bun:1.3.8";
const runner = new SystemCommandRunner();
requireTailscale(runner);
const before = readTailscaleServe(runner);
const candidates = [14443, 14444, 14445, 14446];
const ports = candidates.filter((p) => !(before.TCP as any)?.[p]).slice(0, 2);
assert.equal(ports.length, 2, "Need two unused test HTTPS ports");
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
const apiPort = String(portProbe.port);
await portProbe.stop(true);
const directory = mkdtempSync(join(tmpdir(), "openteam-tailscale-live-"));
const paths = installationPaths(directory);
const projectName = `openteam-ts-qa-${process.pid}`;
let env = createEnvironment({ version: "1.2.3" });
env = replaceEnvironmentValue(env, "OPENTEAM_API_PORT", apiPort);
writeFileAtomic(paths.environment, env);
writeManifest(paths, {
  schemaVersion: 1,
  repository: "qa/fixture",
  version: "1.2.3",
  composeUrl: "https://example.com/fixture",
  installedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ownerUsername: "qa",
  projectName,
});
writeFileSync(
  join(directory, "backend.ts"),
  `Bun.serve({port:8787,fetch(req,server){const url=new URL(req.url);if(url.pathname==='/ws'){if(server.upgrade(req))return;return new Response('upgrade required',{status:400});}if(url.pathname==='/config')return Response.json({url:process.env.OPENTEAM_PUBLIC_URL,authUrl:process.env.OPENTEAM_AUTH_URL,mode:process.env.OPENTEAM_ACCESS_MODE});return Response.json({status:'ready',release:{releaseVersion:'1.2.3'}});},websocket:{message(ws,message){ws.send(message)}}});`
);
writeFileAtomic(
  paths.compose,
  `services:
  server:
    image: ${JSON.stringify(image)}
    command: ["bun", "/qa/backend.ts"]
    volumes: ["./backend.ts:/qa/backend.ts:ro"]
    environment:
      OPENTEAM_PUBLIC_URL: \${OPENTEAM_PUBLIC_URL}
      OPENTEAM_AUTH_URL: \${OPENTEAM_AUTH_URL}
      OPENTEAM_ACCESS_MODE: \${OPENTEAM_ACCESS_MODE}
    ports: ["\${OPENTEAM_BIND_HOST}:\${OPENTEAM_API_PORT}:8787"]
  computer:
    image: ${JSON.stringify(image)}
    command: ["sleep", "infinity"]
  caddy:
    image: ${JSON.stringify(image)}
    profiles: ["https"]
    command: ["sleep", "infinity"]
`
);
const project = requireComposeProject(paths, runner, projectName);
const wsEcho = (url: string) =>
  new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket timeout"));
    }, 10_000);
    ws.onopen = () => ws.send("openteam-tailscale-qa");
    ws.onmessage = (event) => {
      clearTimeout(timeout);
      ws.close();
      try {
        assert.equal(event.data, "openteam-tailscale-qa");
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error("WebSocket failed"));
    };
  });
const runCli = (action: string, extra: string[] = []) => {
  const result = runner.run(
    process.execPath.endsWith("bun") ? "node" : process.execPath,
    [
      new URL("../dist/openteam.js", import.meta.url).pathname,
      "tailscale",
      action,
      "--dir",
      directory,
      "--json",
      ...extra,
    ],
    { timeoutMs: 240_000 }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
let completed = false;
try {
  project.runOrThrow(["up", "--detach"]);
  runCli("enable", ["--https-port", String(ports[0])]);
  let status = await tailscaleStatus(paths, runner, true);
  assert.equal(status.issue, null);
  assert.equal(status.verified, true);
  assert.equal(status.ownership, "openteam");
  const config = await (await fetch(status.publicUrl + "/config")).json();
  assert.deepEqual(config, { url: status.publicUrl, authUrl: status.publicUrl, mode: "tailscale" });
  await wsEcho(status.publicUrl);
  console.log(
    "PASS bundled Node CLI, real Docker restart, HTTPS certificate/health, propagated config, and WSS echo"
  );
  project.runOrThrow(["restart", "server"]);
  await configureTailscale(paths, runner, "enable");
  assert.equal(managedTailscaleRoutes(paths).length, 1);
  console.log("PASS restart and idempotent enable retain the custom port");
  await configureTailscale(paths, runner, "enable", String(ports[1]));
  status = await tailscaleStatus(paths, runner, true);
  assert.equal(status.httpsPort, String(ports[1]));
  assert.equal(status.issue, null);
  assert.equal((readTailscaleServe(runner).TCP as any)?.[String(ports[0])], undefined);
  await wsEcho(status.publicUrl);
  console.log("PASS port migration and retired-route cleanup");
  runCli("disable");
  assert.equal(
    parseEnvironment(readFileSync(paths.environment, "utf8")).get("OPENTEAM_ACCESS_MODE"),
    "local"
  );
  assert.equal((await tailscaleStatus(paths, runner)).enabled, false);
  assert.deepEqual(readTailscaleServe(runner), before);
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/v0/health`)).status, 200);
  console.log("PASS disable restores local access and preserves every original Serve mapping");
  completed = true;
} finally {
  cleanManagedTailscaleRoutes(paths, runner);
  project.runOrThrow(["down", "--volumes", "--remove-orphans"]);
  assert.deepEqual(
    readTailscaleServe(runner),
    before,
    "Original Serve configuration must be preserved"
  );
  rmSync(directory, { recursive: true, force: true });
  console.log(`Cleanup complete (${completed ? "all checks passed" : "test failed"}).`);
}
