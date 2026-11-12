import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironment,
  installationPaths,
  parseEnvironment,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import { configureTailscale, tailscaleStatus } from "../src/tailscale-command";
import { configureTailscaleRoute } from "../src/tailscale-https";
import { managedTailscaleRoutes } from "../src/tailscale-state";
import type { CommandRunner, RunResult } from "../src/process";

const host = "bot.tail123.ts.net";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "openteam-tailscale-"));
  dirs.push(dir);
  const paths = installationPaths(dir);
  const original = createEnvironment({ version: "1.2.3" });
  writeFileAtomic(paths.environment, original);
  writeFileAtomic(paths.compose, "services: {}\n");
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "owner/repo",
    version: "1.2.3",
    composeUrl: "https://example.com/compose.yaml",
    installedAt: "now",
    updatedAt: "now",
    ownerUsername: "owner",
  });
  let serve: any = { TCP: {}, Web: {} };
  let status: any = {
    BackendState: "Running",
    Self: { DNSName: `${host}.`, TailscaleIPs: ["100.100.10.5"] },
    CertDomains: [host],
  };
  const calls: string[][] = [];
  let failure: ((command: string, args: readonly string[]) => RunResult | null) | null = null;
  const runner: CommandRunner = {
    run(command, args) {
      calls.push([command, ...args]);
      const failed = failure?.(command, args);
      if (failed) return failed;
      if (command === "tailscale") {
        if (args[0] === "status") return ok(JSON.stringify(status));
        if (args[1] === "status") return ok(JSON.stringify(serve));
        const port = args.find((a) => a.startsWith("--https="))!.split("=")[1]!;
        if (args.includes("off")) {
          delete serve.TCP[port];
          delete serve.Web[`${host}:${port}`];
        } else {
          serve.TCP[port] = { HTTPS: true };
          serve.Web[`${host}:${port}`] = { Handlers: { "/": { Proxy: args.at(-1) } } };
        }
        return ok();
      }
      if (args.includes("version")) return ok("2.30.0");
      if (args.includes("ps"))
        return args.includes("--services") ? ok("server\ncomputer\nworker\npostgres") : ok("[]");
      return ok();
    },
  };
  const dependencies = {
    health: async () => ({ ok: true, url: "http://127.0.0.1:8787/api/v0/health", detail: "ready" }),
    verify: async (_url: string) => {},
    waitMs: 0,
  };
  return {
    paths,
    original,
    runner,
    calls,
    dependencies,
    get serve() {
      return serve;
    },
    setServe(v: any) {
      serve = v;
    },
    setStatus(v: any) {
      status = v;
    },
    fail(v: typeof failure) {
      failure = v;
    },
  };
}
const mapping = (port: string, backend = "8787") => ({
  TCP: { [port]: { HTTPS: true } },
  Web: { [`${host}:${port}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${backend}` } } } },
});

describe("connection lifecycle", () => {
  test("enable, reapply, change port, and disable preserve other routes and secrets", async () => {
    const f = fixture();
    f.setServe(mapping("443", "9000"));
    const other = structuredClone(f.serve.Web);
    await configureTailscale(f.paths, f.runner, "enable", "14443", f.dependencies);
    const env = parseEnvironment(readFileSync(f.paths.environment, "utf8"));
    expect(env.get("OPENTEAM_ACCESS_MODE")).toBe("tailscale");
    expect(env.get("OPENTEAM_PUBLIC_URL")).toBe(`https://${host}:14443`);
    expect(env.get("OPENTEAM_AUTH_URL")).toBe(env.get("OPENTEAM_PUBLIC_URL"));
    expect(env.get("OPENTEAM_AUTH_SECRET")).toBe(
      parseEnvironment(f.original).get("OPENTEAM_AUTH_SECRET")
    );
    expect(await tailscaleStatus(f.paths, f.runner)).toMatchObject({
      route: "matching",
      ownership: "openteam",
      issue: null,
    });
    await configureTailscale(f.paths, f.runner, "enable", undefined, f.dependencies);
    expect(f.calls.filter((c) => c.includes("--bg"))).toHaveLength(1);
    await configureTailscale(f.paths, f.runner, "enable", "14444", f.dependencies);
    expect(f.serve.TCP["14443"]).toBeUndefined();
    expect(f.serve.TCP["14444"]).toEqual({ HTTPS: true });
    await configureTailscale(f.paths, f.runner, "disable", undefined, f.dependencies);
    expect(f.serve.Web).toEqual(other);
    expect(managedTailscaleRoutes(f.paths)).toEqual([]);
    expect(
      parseEnvironment(readFileSync(f.paths.environment, "utf8")).get("OPENTEAM_ACCESS_MODE")
    ).toBe("local");
  });

  test("a reused external route is not claimed or removed on disable", async () => {
    const f = fixture();
    f.setServe(mapping("14443"));
    await configureTailscale(f.paths, f.runner, "enable", "14443", f.dependencies);
    expect((await tailscaleStatus(f.paths, f.runner)).ownership).toBe("external");
    await configureTailscale(f.paths, f.runner, "disable", undefined, f.dependencies);
    expect(f.serve).toEqual(mapping("14443"));
    expect(f.calls.some((c) => c.includes("off"))).toBe(false);
  });

  test("certificate/endpoint failure rolls back env and newly created route", async () => {
    const f = fixture();
    await expect(
      configureTailscale(f.paths, f.runner, "enable", "14443", {
        ...f.dependencies,
        verify: async () => {
          throw new Error("untrusted certificate");
        },
      })
    ).rejects.toThrow("Previous configuration restored");
    expect(readFileSync(f.paths.environment, "utf8")).toBe(f.original);
    expect(Object.keys(f.serve.TCP)).toEqual([]);
    expect(managedTailscaleRoutes(f.paths)).toEqual([]);
  });

  test("changed managed mappings are reported and preserved", async () => {
    const f = fixture();
    await configureTailscale(f.paths, f.runner, "enable", "14443", f.dependencies);
    f.setServe(mapping("14443", "9999"));
    expect(await tailscaleStatus(f.paths, f.runner)).toMatchObject({
      route: "conflict",
      ownership: "openteam",
    });
    await expect(
      configureTailscale(f.paths, f.runner, "disable", undefined, f.dependencies)
    ).rejects.toThrow("old route was preserved");
    expect(f.serve).toEqual(mapping("14443", "9999"));
    expect(managedTailscaleRoutes(f.paths)).toHaveLength(1);
  });

});

test("permissions and tailnet enablement links are actionable without echoing secrets", () => {
  const f = fixture();
  const node = { host, addresses: [], port: "14443" };
  for (const [stderr, expected] of [
    ["permission denied tskey-secret", "operator"],
    [
      "Serve is not enabled https://login.tailscale.com/f/serve?node=abc tskey-secret",
      "https://login.tailscale.com/f/serve?node=abc",
    ],
  ]) {
    f.fail((cmd, args) =>
      args.includes("--bg") ? { status: 1, stdout: "", stderr: stderr! } : null
    );
    try {
      configureTailscaleRoute(f.runner, node, "8787");
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).toContain(expected!);
      expect(String(error)).not.toContain("tskey-secret");
    }
  }
});

test("a route created before a command timeout is tracked and rolled back", async () => {
  const f = fixture();
  f.fail((command, args) => {
    if (command !== "tailscale" || !args.includes("--bg")) return null;
    f.setServe(mapping("14443"));
    return { status: 1, stdout: "", stderr: "ETIMEDOUT" };
  });
  await expect(
    configureTailscale(f.paths, f.runner, "enable", "14443", f.dependencies)
  ).rejects.toThrow("Previous configuration restored");
  expect(managedTailscaleRoutes(f.paths)).toEqual([]);
  expect(Object.keys(f.serve.TCP)).toEqual([]);
});

