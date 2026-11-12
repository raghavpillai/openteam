import { expect, test } from "bun:test";
import { configureTailscaleRoute, detectTailscaleHttps } from "../src/tailscale-https";
import type { CommandRunner } from "../src/process";
import { createSetupSession } from "../src/setup-session";
import { SETUP_STAGES, validateProxyHost } from "../src/setup-values";

const host = "bot.tail123.ts.net";
const matching = (port = "8787") => ({
  TCP: { "443": { HTTPS: true } },
  Web: {
    [`${host}:443`]: {
      Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } },
    },
  },
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
        const port = args.find((arg) => arg.startsWith("--https="))!.slice("--https=".length);
        const current = serve as { TCP?: object; Web?: object };
        serve = {
          TCP: { ...current.TCP, [port]: { HTTPS: true } },
          Web: {
            ...current.Web,
            [`${host}:${port}`]: { Handlers: { "/": { Proxy: args.at(-1) } } },
          },
        };
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
  expect(f.calls.filter((args) => args.includes("--bg"))).toEqual([
    ["serve", "--bg", "--https=443", "http://127.0.0.1:8787"],
  ]);
  expect(configureTailscaleRoute(f.runner, candidate, "8787")).toBe(false);
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
    expect(() => configureTailscaleRoute(other.runner, { host, addresses: [] }, "8787")).toThrow();
    expect(other.calls.some((args) => args.includes("--bg"))).toBe(false);
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
