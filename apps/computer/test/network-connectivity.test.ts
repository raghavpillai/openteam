import { expect, test } from "bun:test";
import { startNetworkConnectivity, probeNetworkFamily } from "../src/network-connectivity";
import type { NetworkFamilyHealth } from "@openteam/plugin-sdk/browser-network/protocol";

const working: NetworkFamilyHealth = { state: "working" };
const unavailable: NetworkFamilyHealth = { state: "unavailable", reason: "connect_failed" };
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
function fixture(
  verify?: (family: "ipv4" | "ipv6", signal: AbortSignal) => Promise<NetworkFamilyHealth>
) {
  let route: { epoch: string; sourceId: string } | null = { epoch: "one", sourceId: "mini" };
  const results = { ipv4: working, ipv6: unavailable };
  const applied: Array<{ ipv4: boolean; ipv6: boolean }> = [];
  let errors = 0;
  const monitor = startNetworkConnectivity({
    route: () => route,
    probe: async (family) => results[family],
    verify,
    apply: async (families) => {
      applied.push(families);
    },
    changed: () => {},
    failed: () => errors++,
    retryMs: 1,
    intervalMs: 1,
  });
  monitor.sync();
  return {
    monitor,
    results,
    applied,
    errors: () => errors,
    route: (value: typeof route) => {
      route = value;
      monitor.sync();
    },
  };
}

test("an IPv4-only exit enables IPv4, blocks IPv6 before TUN, and recovers dual stack", async () => {
  const f = fixture();
  try {
    expect(f.monitor.status()?.ipv6.state).toBe("checking");
    await until(() => f.monitor.status()?.ipv6.state === "unavailable");
    expect(f.applied.at(-1)).toEqual({ ipv4: true, ipv6: false });
    expect(f.monitor.status()).toMatchObject({ epoch: "one", sourceId: "mini", ipv4: working });
    f.results.ipv6 = working;
    await Bun.sleep(5);
    f.monitor.sync();
    await until(() => f.monitor.status()?.ipv6.state === "working");
    expect(f.applied.at(-1)).toEqual({ ipv4: true, ipv6: true });
    f.results.ipv4 = unavailable;
    await Bun.sleep(5);
    f.monitor.sync();
    await until(() => f.monitor.status()?.ipv4.state === "checking");
    expect(f.applied.at(-1)).toEqual({ ipv4: true, ipv6: true });
    await Bun.sleep(5);
    f.monitor.sync();
    await until(() => f.monitor.status()?.ipv4.state === "unavailable");
    expect(f.applied.at(-1)).toEqual({ ipv4: false, ipv6: true });
    expect(f.errors()).toBe(0);
  } finally {
    await f.monitor.close();
  }
  expect(f.applied.at(-1)).toEqual({ ipv4: false, ipv6: false });
});

test("upstream TLS success cannot hide a broken ordinary TUN path", async () => {
  const f = fixture(async () => unavailable);
  try {
    await until(() => f.monitor.status()?.ipv4.reason === "path_failed");
    expect(f.applied.at(-1)).toEqual({ ipv4: false, ipv6: false });
  } finally {
    await f.monitor.close();
  }
});

test("route changes clear health and cancel obsolete measurements before enabling routes", async () => {
  let route: { epoch: string; sourceId: string } | null = { epoch: "old", sourceId: "a" };
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const applied: Array<{ ipv4: boolean; ipv6: boolean }> = [];
  let probes = 0,
    errors = 0;
  const monitor = startNetworkConnectivity({
    route: () => route,
    probe: async (_family, signal) => {
      probes++;
      if (probes <= 2) await waiting;
      signal.throwIfAborted();
      return working;
    },
    apply: async (families) => {
      applied.push(families);
    },
    changed: () => {},
    failed: () => errors++,
  });
  try {
    monitor.sync();
    await until(() => probes === 2);
    route = { epoch: "new", sourceId: "b" };
    monitor.sync();
    expect(monitor.status()?.epoch).toBe("new");
    expect(monitor.status()?.ipv4.state).toBe("checking");
    release();
    await until(() => monitor.status()?.ipv4.state === "working");
    expect(monitor.status()?.sourceId).toBe("b");
    expect(applied.filter((f) => f.ipv4)).toHaveLength(1);
    expect(errors).toBe(0);
    route = null;
    monitor.sync();
    await until(() => !applied.at(-1)?.ipv4);
    expect(monitor.status()).toBeUndefined();
  } finally {
    release();
    await monitor.close();
  }
});

test("repeated lease notifications coalesce a pending measurement", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 25; i++) f.monitor.sync();
    await until(() => f.monitor.status()?.checkedAt != null);
    expect(f.applied.filter((v) => v.ipv4)).toHaveLength(1);
  } finally {
    await f.monitor.close();
  }
});

test("independent provider failures classify connection vs TLS without leaking errors", async () => {
  const hosts: string[] = [];
  const result = await probeNetworkFamily(
    async (host) => {
      hosts.push(host);
      throw Error("sensitive internal error");
    },
    "ipv6",
    new AbortController().signal
  );
  expect(hosts).toHaveLength(2);
  expect(hosts.every((host) => host.includes(":"))).toBe(true);
  expect(result).toEqual(unavailable);
  const controller = new AbortController();
  controller.abort();
  await expect(
    probeNetworkFamily(
      async () => {
        throw Error();
      },
      "ipv4",
      controller.signal
    )
  ).rejects.toThrow();
});
