import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseEnvironment } from "../src/config";
import type { CommandRunner, RunResult } from "../src/process";
import { createSetupSession } from "../src/setup-session";
import { SETUP_STAGES, validateProxyHost } from "../src/setup-values";
import { configureTailscale, tailscaleStatus } from "../src/tailscale-command";
import { configureTailscaleRoute, detectTailscaleHttps } from "../src/tailscale-https";
import { managedTailscaleRoutes } from "../src/tailscale-state";
import { installStack, ok, scratch } from "./fixtures/harness";

const s = scratch();
const host = "bot.tail123.ts.net";

/** An installation plus a fake tailnet whose `tailscale serve` routes are kept in memory. */
function fixture(initialServe: any = { TCP: {}, Web: {} }) {
  const { paths, environment: original } = installStack(s.dir("openteam-tailscale-"));
  let serve = initialServe;
  const status = {
    BackendState: "Running",
    Self: { DNSName: `${host}.`, TailscaleIPs: ["100.100.10.5"] },
    CertDomains: [host],
  };
  const calls: string[][] = [];
  let failure: ((command: string, args: readonly string[]) => RunResult | null) | null = null;
  const runner: CommandRunner = {
    run(command, args, options) {
      calls.push([command, ...args]);
      const failed = failure?.(command, args);
      if (failed) return failed;
      if (command === "tailscale") {
        expect(options?.timeoutMs).toBeLessThanOrEqual(10_000);
        if (args[0] === "status") return ok(JSON.stringify(status));
        if (args[1] === "status") return ok(JSON.stringify(serve));
        const port = args.find((a) => a.startsWith("--https="))!.split("=")[1]!;
        serve.TCP ??= {};
        serve.Web ??= {};
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
    status,
    dependencies,
    bg: () => calls.filter((call) => call.includes("--bg")),
    get serve() {
      return serve;
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
    const f = fixture(mapping("443", "9000"));
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
    const f = fixture(mapping("14443"));
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
});

describe("Tailscale HTTPS during setup", () => {
  test("setup prefers private Tailscale HTTPS and creates a verified persistent route", () => {
    const f = fixture({});
    const candidate = detectTailscaleHttps(f.runner, "8787")!;
    expect(candidate).toEqual({ host, addresses: ["100.100.10.5"] });
    const setup = createSetupSession({
      version: "test",
      stages: SETUP_STAGES,
      current: new Map(),
      fresh: true,
      ownerConfigured: true,
      preferredHttpsHost: candidate.host,
    });
    expect(setup.configuration()).toMatchObject({
      accessMode: "tailscale",
      publicUrl: `https://${host}`,
      bindHost: "127.0.0.1",
      composeProfiles: "direct",
    });
    expect(configureTailscaleRoute(f.runner, candidate, "8787")).toBe(true);
    expect(f.bg()).toEqual([
      ["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:8787"],
    ]);
    expect(configureTailscaleRoute(f.runner, candidate, "8787")).toBe(false);
    expect(f.bg()).toHaveLength(1);
  });

  test("detection avoids disabled HTTPS and every incompatible route", () => {
    const f = fixture({});
    f.status.CertDomains = [];
    expect(detectTailscaleHttps(f.runner, "8787")).toBeNull();
    f.status.CertDomains = [host];
    f.status.BackendState = "NeedsLogin";
    expect(detectTailscaleHttps(f.runner, "8787")).toBeNull();
    for (const config of [
      mapping("443", "9999"),
      { TCP: { "443": { TCPForward: "localhost:8787" } } },
      { Foreground: { other: mapping("443") } },
      { ...mapping("443"), AllowFunnel: { [`${host}:443`]: true } },
      {
        ...mapping("443"),
        Web: {
          [`${host}:443`]: {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:8787" },
              "/api": { Proxy: "http://127.0.0.1:9999" },
            },
          },
        },
      },
    ]) {
      const other = fixture(config);
      expect(detectTailscaleHttps(other.runner, "8787")).toBeNull();
      expect(() =>
        configureTailscaleRoute(other.runner, { host, addresses: [] }, "8787")
      ).toThrow();
      expect(other.bg()).toEqual([]);
    }
  });

  test("proxy endpoints validate ports without accepting paths or credentials", () => {
    for (const value of [
      `${host}:0`,
      `${host}:65536`,
      `${host}:123/path`,
      `user@${host}:10000`,
      `${host}:abc`,
      `${host}:80:443`,
    ]) {
      expect(() => validateProxyHost(value)).toThrow();
    }
    expect(validateProxyHost(`${host}:443`)).toBe(host);
  });
});
