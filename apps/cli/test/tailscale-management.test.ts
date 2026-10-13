import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironment,
  installationPaths,
  parseEnvironment,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import { parseArguments } from "../src/arguments";
import { configureTailscale, tailscaleStatus } from "../src/tailscale-command";
import { inspectTailscale, configureTailscaleRoute, tailscaleRoute } from "../src/tailscale-https";
import {
  managedTailscaleRoutes,
  ensureManagedTailscaleRoute,
  removeManagedTailscaleRoute,
} from "../src/tailscale-state";
import { createSetupSession } from "../src/setup-session";
import { collectSetupConfiguration } from "../src/setup";
import { SETUP_STAGES } from "../src/setup-values";
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

test("CLI exposes explicit management commands and validates ports", () => {
  expect(parseArguments(["tailscale", "enable", "--https-port", "14443", "--json"])).toMatchObject({
    command: "tailscale-enable",
    httpsPort: "14443",
    json: true,
  });
  expect(parseArguments(["tailscale", "status"])).toMatchObject({ command: "tailscale-status" });
  expect(parseArguments(["tailscale", "disable"])).toMatchObject({ command: "tailscale-disable" });
  expect(parseArguments(["help", "tailscale", "enable"])).toMatchObject({
    helpTopic: "tailscale-enable",
  });
  for (const p of ["0", "65536", "-1", "x", "443/path"])
    expect(() => parseArguments(["tailscale", "enable", "--https-port", p])).toThrow();
  expect(() => parseArguments(["tailscale", "disable", "--https-port", "443"])).toThrow();
});

test("normal setup exposes Tailscale, previews custom port, and keeps backend loopback", () => {
  const f = fixture();
  const setup = createSetupSession({
    version: "test",
    stages: SETUP_STAGES,
    current: parseEnvironment(f.original),
    authenticated: true,
    fresh: true,
    ownerConfigured: true,
    tailscaleHost: host,
  });
  expect(setup.view().title).toBe("1. Connection");
  expect(setup.rows().some((r) => "id" in r && r.id === "access:tailscale")).toBe(true);
  setup.handle("6", { name: "6" });
  expect(setup.state.accessMode).toBe("tailscale");
  // Port is the only editable value; the hostname comes from the host daemon.
  expect(setup.rows().some((r) => "id" in r && r.id === "tailscalePort")).toBe(true);
  expect(setup.rows().some((r) => "id" in r && r.id === "host")).toBe(false);
  setup.handle("14443", { name: "1" });
  setup.handle("", { name: "return" });
  expect(setup.configuration()).toMatchObject({
    accessMode: "tailscale",
    publicUrl: `https://${host}:14443`,
    bindHost: "127.0.0.1",
    viewerBindHost: "127.0.0.1",
    composeProfiles: "direct",
  });
});

test("typed setup offers the same explicit Tailscale selection", async () => {
  const f = fixture();
  const answers = ["tailscale", "14443", "skip"];
  const config = await collectSetupConfiguration(
    parseEnvironment(f.original),
    true,
    {
      question: async () => answers.shift()!,
      secret: async () => {
        throw new Error("unexpected secret");
      },
      close() {},
    },
    { ownerConfigured: true, tailscaleHost: host }
  );
  expect(config).toMatchObject({
    accessMode: "tailscale",
    publicUrl: `https://${host}:14443`,
    skipInference: true,
  });
  expect(answers).toHaveLength(0);
});

test("missing prerequisites stay visible and block setup", () => {
  const f = fixture();
  const setup = createSetupSession({
    version: "test",
    stages: SETUP_STAGES,
    current: parseEnvironment(f.original),
    authenticated: true,
    ownerConfigured: true,
    tailscaleIssue: "Install Tailscale on this host.",
  });
  setup.handle("6", { name: "6" });
  expect(setup.problems().some((p) => p.message.includes("Install Tailscale"))).toBe(true);
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

  test("failed port migration preserves the old working route", async () => {
    const f = fixture();
    await configureTailscale(f.paths, f.runner, "enable", "14443", f.dependencies);
    const before = readFileSync(f.paths.environment, "utf8");
    await expect(
      configureTailscale(f.paths, f.runner, "enable", "14444", {
        ...f.dependencies,
        verify: async () => {
          throw new Error("endpoint not ready");
        },
      })
    ).rejects.toThrow("Previous configuration restored");
    expect(readFileSync(f.paths.environment, "utf8")).toBe(before);
    expect(f.serve).toEqual(mapping("14443"));
  });

  test("failed reuse never removes a user's mapping", async () => {
    const f = fixture();
    f.setServe(mapping("14443"));
    await expect(
      configureTailscale(f.paths, f.runner, "enable", "14443", {
        ...f.dependencies,
        verify: async () => {
          throw new Error("DNS failure");
        },
      })
    ).rejects.toThrow("DNS failure");
    expect(f.serve).toEqual(mapping("14443"));
  });

  test("Compose validation and startup errors restore environment before exposing Serve", async () => {
    for (const failure of ["config", "up"]) {
      const f = fixture();
      f.fail((command, args) =>
        command === "docker" && args.includes(failure)
          ? { status: 1, stdout: "", stderr: "fixture failure" }
          : null
      );
      await expect(
        configureTailscale(f.paths, f.runner, "enable", "14443", f.dependencies)
      ).rejects.toThrow("Previous configuration restored");
      expect(readFileSync(f.paths.environment, "utf8")).toBe(f.original);
      expect(f.calls.some((c) => c.includes("--bg"))).toBe(false);
    }
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

  test("missing mapping is detected and repaired after restart", async () => {
    const f = fixture();
    await configureTailscale(f.paths, f.runner, "enable", "14443", f.dependencies);
    f.setServe({ TCP: {}, Web: {} });
    expect((await tailscaleStatus(f.paths, f.runner)).route).toBe("missing");
    await configureTailscale(f.paths, f.runner, "enable", undefined, f.dependencies);
    expect((await tailscaleStatus(f.paths, f.runner)).route).toBe("matching");
  });
});

test("unavailable CLI, stopped daemon, logged-out node, MagicDNS and HTTPS have distinct remedies", () => {
  const f = fixture();
  f.fail(() => ({
    status: 1,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
  }));
  expect(inspectTailscale(f.runner).issue).toContain("Install Tailscale");
  f.fail(null);
  for (const [status, remedy] of [
    [{ BackendState: "Stopped" }, "Start Tailscale"],
    [{ BackendState: "NeedsLogin" }, "tailscale up"],
    [{ BackendState: "Running", Self: {} }, "MagicDNS"],
    [{ BackendState: "Running", Self: { DNSName: host } }, "HTTPS certificates"],
  ] as const) {
    f.setStatus(status);
    expect(inspectTailscale(f.runner).issue).toContain(remedy);
  }
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

test("Funnel, extra paths, mixed TCP forwarding, and foreground sessions are never mutated", () => {
  const f = fixture();
  const node = { host, addresses: [], port: "443" };
  for (const config of [
    { ...mapping("443"), AllowFunnel: { [`${host}:443`]: true } },
    { ...mapping("443"), Foreground: { session: {} } },
    { ...mapping("443"), TCP: { "443": { HTTPS: true, TCPForward: "localhost:9000" } } },
    {
      ...mapping("443"),
      Web: {
        [`${host}:443`]: {
          Handlers: { "/": { Proxy: "http://localhost:8787" }, "/other": { Text: "hi" } },
        },
      },
    },
  ]) {
    f.setServe(config);
    expect(() => configureTailscaleRoute(f.runner, node, "8787")).toThrow();
    expect(tailscaleRoute(config, host, "8787")).toBe("occupied");
  }
  expect(f.calls.some((c) => c.includes("--bg") || c.includes("off"))).toBe(false);
});

test("owned mapping cannot be deleted after another app adds a handler", () => {
  const f = fixture();
  const entry = ensureManagedTailscaleRoute(
    f.paths,
    f.runner,
    { host, addresses: [], port: "14443" },
    "8787"
  )!;
  f.serve.Web[`${host}:14443`].Handlers["/other"] = { Text: "another app" };
  expect(() => removeManagedTailscaleRoute(f.paths, f.runner, entry)).toThrow("preserved");
  expect(f.calls.some((c) => c.includes("off"))).toBe(false);
});

test("enable migrates a legacy matching custom-port route without touching another app on 443", async () => {
  const f = fixture();
  const first = mapping("443", "9000");
  const legacy = mapping("10000");
  f.setServe({ TCP: { ...first.TCP, ...legacy.TCP }, Web: { ...first.Web, ...legacy.Web } });
  const before = structuredClone(f.serve);
  await configureTailscale(f.paths, f.runner, "enable", undefined, f.dependencies);
  expect(await tailscaleStatus(f.paths, f.runner)).toMatchObject({
    httpsPort: "10000",
    route: "matching",
    ownership: "external",
  });
  expect(f.serve).toEqual(before);
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

test("rollback restores env even when safe route cleanup is refused", async () => {
  const f = fixture();
  await expect(
    configureTailscale(f.paths, f.runner, "enable", "14443", {
      ...f.dependencies,
      verify: async () => {
        f.serve.Web[`${host}:14443`].Handlers["/other"] = { Text: "another app" };
        throw new Error("verification failed");
      },
    })
  ).rejects.toThrow("cleanup needs attention");
  expect(readFileSync(f.paths.environment, "utf8")).toBe(f.original);
  expect(managedTailscaleRoutes(f.paths)).toHaveLength(1);
  expect((await tailscaleStatus(f.paths, f.runner)).issue).toContain("changed externally");
});

test("settings suggest the existing private HTTPS port before enabling", async () => {
  const f = fixture();
  const a = mapping("443", "9000"),
    b = mapping("10000");
  f.setServe({ TCP: { ...a.TCP, ...b.TCP }, Web: { ...a.Web, ...b.Web } });
  expect(await tailscaleStatus(f.paths, f.runner)).toMatchObject({
    enabled: false,
    httpsPort: "10000",
    hostname: host,
  });
});

test("changing connection mode in quick setup asks for the new public hostname", async () => {
  const f = fixture();
  let env = replaceEnvironmentValue(f.original, "OPENTEAM_ACCESS_MODE", "private");
  env = replaceEnvironmentValue(env, "OPENTEAM_PUBLIC_URL", "http://100.100.10.5:8787");
  const answers = ["https", "bot.example.com", "skip"];
  const prompts: string[] = [];
  const config = await collectSetupConfiguration(
    parseEnvironment(env),
    true,
    {
      question: async (prompt) => {
        prompts.push(prompt);
        return answers.shift()!;
      },
      secret: async () => {
        throw new Error("unexpected secret");
      },
      close() {},
    },
    { ownerConfigured: true }
  );
  expect(prompts.some((p) => p.startsWith("Public domain"))).toBe(true);
  expect(config.publicUrl).toBe("https://bot.example.com");
});
