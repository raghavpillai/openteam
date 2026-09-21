import { expect, test } from "bun:test";
import { detectTailscaleHttps, ensureTailscaleHttps, tailscaleHttpsHost } from "../src/tailscale-https";
import type { CommandRunner } from "../src/process";
import { createSetupSession } from "../src/setup-session";
import { SETUP_STAGES, existingReachableHost, validateProxyHost } from "../src/setup-values";

const host = "bot.tail123.ts.net";
const matching = (port = "8787") => ({
  TCP: { "443": { HTTPS: true } },
  Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
});
function fixture(config: object = {}) {
  const calls: string[][] = [];
  let serve = config;
  const status = {
    BackendState: "Running",
    Self: { DNSName: `${host}.`, TailscaleIPs: ["100.100.10.5"] },
    CertDomains: [host],
  };
  const runner: CommandRunner = {
    run(command, args, options) {
      expect(command).toBe("tailscale");
      expect(options?.timeoutMs).toBeLessThanOrEqual(10_000);
      calls.push([...args]);
      if (args[0] === "status") return { status: 0, stdout: JSON.stringify(status), stderr: "" };
      if (args.includes("--bg")) {
        serve = matching();
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify(serve), stderr: "" };
    },
  };
  return {
    runner,
    calls,
    status,
    setServe: (value: object) => {
      serve = value;
    },
  };
}

test("setup prefers private Tailscale HTTPS and creates a verified persistent route", () => {
  const f = fixture();
  const candidate = detectTailscaleHttps(f.runner, "8787")!;
  expect(candidate).toEqual({ host, addresses: ["100.100.10.5"] });
  const setup = createSetupSession({
    version: "test",
    stages: SETUP_STAGES,
    current: new Map(),
    authenticated: true,
    fresh: true,
    ownerConfigured: true,
    preferredHttpsHost: candidate.host,
  });
  expect(setup.configuration()).toMatchObject({
    accessMode: "proxy",
    publicUrl: `https://${host}`,
    bindHost: "127.0.0.1",
    composeProfiles: "direct",
  });
  expect(ensureTailscaleHttps(f.runner, candidate, "8787")).toBe(true);
  expect(f.calls.filter((args) => args.includes("--bg"))).toEqual([
    ["serve", "--bg", "--https=443", "http://127.0.0.1:8787"],
  ]);
  expect(ensureTailscaleHttps(f.runner, candidate, "8787")).toBe(true);
  expect(f.calls.filter((args) => args.includes("--bg"))).toHaveLength(1);
});

test("detection avoids disabled HTTPS and every incompatible route", () => {
  const f = fixture();
  f.status.CertDomains = [];
  expect(detectTailscaleHttps(f.runner, "8787")).toBeNull();
  f.status.CertDomains = [host];
  f.status.BackendState = "NeedsLogin";
  expect(detectTailscaleHttps(f.runner, "8787")).toBeNull();
  for (const config of [
    matching("9999"),
    { TCP: { "443": { TCPForward: "localhost:8787" } } },
    { Foreground: { other: matching() } },
    { ...matching(), AllowFunnel: { [`${host}:443`]: true } },
    {
      ...matching(),
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
    expect(ensureTailscaleHttps(other.runner, { host, addresses: [] }, "8787")).toBe(false);
    expect(other.calls.some((args) => args.includes("--bg"))).toBe(false);
  }
});

test("route changes during review, missing CLI, and invalid status fall back without mutation", () => {
  const f = fixture();
  const candidate = detectTailscaleHttps(f.runner, "8787")!;
  f.setServe(matching("9000"));
  expect(ensureTailscaleHttps(f.runner, candidate, "8787")).toBe(false);
  for (const runner of [
    { run: () => ({ status: 1, stdout: "", stderr: "unavailable" }) },
    { run: () => ({ status: 0, stdout: "not JSON", stderr: "" }) },
    {
      run: () => {
        throw new Error("missing CLI");
      },
    },
  ]) {
    expect(detectTailscaleHttps(runner, "8787")).toBeNull();
    expect(ensureTailscaleHttps(runner, candidate, "8787")).toBe(false);
  }
});

test("setup reuses an existing private HTTPS port without replacing another app on 443", () => {
  const config = matching("18789");
  const f = fixture({
    TCP: { ...config.TCP, "10000": { HTTPS: true } },
    Web: { ...config.Web, [`${host}:10000`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } },
  });
  const candidate = detectTailscaleHttps(f.runner, "8787")!;
  expect(candidate).toEqual({ host, port: "10000", addresses: ["100.100.10.5"] });
  const address = tailscaleHttpsHost(candidate);
  expect(validateProxyHost(address)).toBe(`${host}:10000`);
  const setup = createSetupSession({ version: "test", stages: SETUP_STAGES, current: new Map(),
    authenticated: true, fresh: true, ownerConfigured: true, preferredHttpsHost: address });
  expect(setup.configuration().publicUrl).toBe(`https://${host}:10000`);
  expect(existingReachableHost(new Map([["OPENTEAM_PUBLIC_URL", `https://${address}`]]))).toBe(address);
  expect(ensureTailscaleHttps(f.runner, candidate, "8787")).toBe(true);
  expect(f.calls.some(args => args.includes("--bg"))).toBe(false);
  f.setServe(config);
  expect(ensureTailscaleHttps(f.runner, candidate, "8787")).toBe(false);
  expect(f.calls.some(args => args.includes("--bg"))).toBe(false);
});

test("proxy endpoints validate ports without accepting paths or credentials", () => {
  for (const value of [`${host}:0`, `${host}:65536`, `${host}:123/path`, `user@${host}:10000`, `${host}:abc`, `${host}:80:443`]) {
    expect(() => validateProxyHost(value)).toThrow();
  }
  expect(validateProxyHost(`${host}:443`)).toBe(host);
});
