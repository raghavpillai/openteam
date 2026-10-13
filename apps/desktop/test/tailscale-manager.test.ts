import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canManageTailscale,
  tailscaleRequest,
  TailscaleManager,
} from "../src/main/tailscale-manager";
import type { TailscaleStatus } from "@openteam/contracts/tailscale";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "openteam-desktop-ts-"));
  dirs.push(directory);
  writeFileSync(join(directory, "installation.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(directory, "compose.yaml"), "services: {}\n");
  writeFileSync(
    join(directory, ".env"),
    "OPENTEAM_API_PORT=8787\nOPENTEAM_ACCESS_MODE=tailscale\nOPENTEAM_PUBLIC_URL=https://bot.tail123.ts.net:14443\n"
  );
  const status: TailscaleStatus = {
    enabled: true,
    publicUrl: "https://bot.tail123.ts.net:14443",
    backendUrl: "http://127.0.0.1:8787",
    httpsPort: "14443",
    hostname: "bot.tail123.ts.net",
    route: "matching",
    ownership: "openteam",
    verified: true,
    issue: null,
    managedRoutes: 1,
  };
  return { directory, status, environment: { OPENTEAM_HOME: directory, PATH: "/fixture/bin" } };
}
test("only loopback or this installation's configured Tailscale URL is manageable", () => {
  const f = fixture();
  const installation = { directory: f.directory, apiPort: "8787", version: "1.2.3" };
  expect(canManageTailscale("http://127.0.0.1:8787", installation)).toBe(true);
  expect(canManageTailscale(f.status.publicUrl, installation)).toBe(true);
  for (const url of [
    "http://127.0.0.1:9000",
    "https://other.tail123.ts.net:14443",
    "https://bot.tail123.ts.net",
    "https://example.com",
  ])
    expect(canManageTailscale(url, installation)).toBe(false);
});
test("IPC validation rejects arbitrary actions, URLs, ports, and credentials", () => {
  for (const request of [
    null,
    {},
    { serverUrl: "file:///tmp/foo", action: "enable" },
    { serverUrl: "https://user:pass@example.com", action: "enable" },
    { serverUrl: "http://localhost:8787/path", action: "enable" },
    { serverUrl: "http://localhost:8787", action: "reset" },
    { serverUrl: "http://localhost:8787", action: "enable", httpsPort: "443; id" },
  ])
    expect(() => tailscaleRequest(request)).toThrow();
  expect(
    tailscaleRequest({ serverUrl: "http://127.0.0.1:8787/", action: "enable", httpsPort: "14443" })
  ).toMatchObject({ action: "enable", httpsPort: "14443" });
});
test("desktop runs bundled CLI with structured arguments and host PATH", async () => {
  const f = fixture();
  const calls: string[][] = [];
  const manager = new TailscaleManager({
    cliPath: "/app/cli.js",
    executablePath: "/app/Electron",
    environment: f.environment,
    run: async (args, env) => {
      calls.push(args);
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(env.PATH).toContain("/opt/homebrew/bin");
      return JSON.stringify(f.status);
    },
  });
  expect(
    await manager.request({
      serverUrl: "http://127.0.0.1:8787",
      action: "enable",
      httpsPort: "14443",
    })
  ).toMatchObject({ canManage: true, status: f.status });
  expect(calls[0]).toEqual([
    "/app/cli.js",
    "tailscale",
    "enable",
    "--dir",
    f.directory,
    "--json",
    "--https-port",
    "14443",
  ]);
});
test("remote settings give instructions and cannot mutate the local host", async () => {
  const f = fixture();
  let calls = 0;
  const manager = new TailscaleManager({
    cliPath: "/app/cli.js",
    executablePath: "/app/Electron",
    environment: f.environment,
    run: async () => {
      calls++;
      return JSON.stringify(f.status);
    },
  });
  expect(
    await manager.request({ serverUrl: "https://remote.example.com", action: "status" })
  ).toMatchObject({ canManage: false, status: null });
  await expect(
    manager.request({ serverUrl: "https://remote.example.com", action: "enable" })
  ).rejects.toThrow("server host");
  expect(calls).toBe(0);
});
test("concurrent operations are rejected and failures release the busy state", async () => {
  const f = fixture();
  let finish!: () => void;
  const manager = new TailscaleManager({
    cliPath: "/app/cli.js",
    executablePath: "/app/Electron",
    environment: f.environment,
    run: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error("failure");
    },
  });
  const request = { serverUrl: "http://localhost:8787", action: "enable" };
  const first = manager.request(request);
  await expect(manager.request(request)).rejects.toThrow("already running");
  finish();
  await expect(first).rejects.toThrow("failure");
  const second = manager.request(request);
  finish();
  await expect(second).rejects.toThrow("failure");
});
