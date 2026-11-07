import { BrowserNetworkClient } from "@openteam/plugin-sdk/browser-network/client";
import { createBrowserProxy } from "@openteam/plugin-sdk/browser-network/socks";
import { createQualityProbe } from "./browser-network-quality";
import { createEgressProbe } from "./browser-network-egress";
import { createInterface } from "node:readline";
import { isIP } from "node:net";
import {
  startComputerDns,
  createDnsExchange,
  globalIpv6Address,
  probeIpv6Route,
} from "./computer-network-dns";
import { runOrdinaryProbe, probeComputerNetwork } from "./computer-network-probe";
import { startManagementDiscovery } from "./computer-network-management";

const lines = createInterface({ input: process.stdin });
let shutdown: (() => void) | undefined,
  parentClosed = false;
lines.once("close", () => {
  parentClosed = true;
  shutdown?.();
});
const input = await new Promise<string>((resolve, reject) => {
  lines.once("line", resolve);
  lines.once("close", () => reject(new Error("Browser network parent disconnected")));
});
if (input.length > 8192) throw new Error("Invalid browser network configuration");
if (process.argv.includes("--computer-network-probe")) {
  const probe = JSON.parse(input);
  try {
    if (!["egress", "quality"].includes(probe.kind) || !probe.route?.epoch) throw new Error();
    console.log(JSON.stringify(await runOrdinaryProbe(probe.kind, probe.route)));
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
const config = JSON.parse(input) as {
  serverUrl: string;
  token: string;
  port: number;
  computerNetwork?: boolean;
};
const diagnostics = new Set<AbortController>();
let diagnosticEpoch: string | undefined;
let dnsExchange: ReturnType<typeof createDnsExchange> | undefined;
// The computer can only serve the IPv6 destinations its own exit can route.
// Device exits resolve and dial on the device, so they keep their own AAAA results.
let ipv6Usable = false,
  ipv6Probing: Promise<void> | undefined;
const suppressIpv6 = () => !ipv6Usable && client.route?.mode !== "device";
const refreshIpv6 = () => {
  if (!globalIpv6Address()) {
    ipv6Usable = false;
    return Promise.resolve();
  }
  ipv6Probing ??= probeIpv6Route()
    .then((usable) => {
      ipv6Usable = usable;
    })
    .finally(() => {
      ipv6Probing = undefined;
    });
  return ipv6Probing;
};
const url = new URL(
  `${config.serverUrl.replace(/\/$/, "")}/api/v0/internal/browser-network/channel`
);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const client: BrowserNetworkClient = new BrowserNetworkClient({
  role: "computer",
  url: url.href,
  headers: { authorization: `Bearer ${config.token}` },
  changed: () => {
    dnsExchange?.syncRoute();
    void refreshIpv6();
    const epoch = client.available() ? client.route?.epoch : undefined;
    if (epoch !== diagnosticEpoch) {
      diagnosticEpoch = epoch;
      for (const diagnostic of diagnostics) diagnostic.abort();
    }
    console.log(JSON.stringify(client.status()));
  },
});
const proxy = createBrowserProxy((host, port) =>
  // Fail a literal IPv6 destination at once instead of accepting then closing mid-TLS.
  isIP(host) === 6 && suppressIpv6()
    ? Promise.reject(new Error("ipv6_unavailable"))
    : client.open(host, port)
);
const port = await proxy.listen(config.port);
await refreshIpv6();
dnsExchange = config.computerNetwork
  ? createDnsExchange(client, {
      routeKey: () => (client.available() ? (client.route?.epoch ?? null) : null),
      ipv6: () => !suppressIpv6(),
    })
  : undefined;
const dns = dnsExchange ? await startComputerDns(dnsExchange) : undefined;
const management = config.computerNetwork
  ? startManagementDiscovery(config.serverUrl, () => client.start())
  : undefined;
if (!config.computerNetwork) client.start();
const egress = createEgressProbe(client);
const quality = createQualityProbe(client);
const checking = new Set<string>();
const ordinaryCache = new Map<string, { epoch: string; until: number; result?: unknown }>();
const ordinaryProbe = async (
  kind: "quality" | "egress",
  route: NonNullable<typeof client.route>,
  signal: AbortSignal
) => {
  const cached = ordinaryCache.get(kind);
  if (cached?.epoch === route.epoch && performance.now() < cached.until) {
    if (cached.result) return cached.result;
    throw new Error("Computer network unavailable");
  }
  try {
    const result = await probeComputerNetwork(kind, route, signal);
    if (!client.available() || client.route?.epoch !== route.epoch) throw new Error();
    ordinaryCache.set(kind, {
      epoch: route.epoch,
      until: performance.now() + (kind === "egress" ? 120_000 : 60_000),
      result,
    });
    return result;
  } catch (error) {
    ordinaryCache.set(kind, {
      epoch: route.epoch,
      until: performance.now() + (kind === "egress" ? 120_000 : 60_000),
    });
    throw error;
  }
};
lines.on("line", (line) => {
  if (line.length > 256) return;
  try {
    const command = JSON.parse(line);
    if (
      !["egress", "quality"].includes(command.op) ||
      typeof command.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(command.id)
    )
      return;
    const id = command.id;
    if (checking.has(command.op)) {
      console.log(JSON.stringify({ id, error: true }));
      return;
    }
    checking.add(command.op);
    const route = client.route;
    const controller = new AbortController();
    diagnostics.add(controller);
    void (
      config.computerNetwork
        ? route && client.available()
          ? ordinaryProbe(command.op, route, controller.signal)
          : Promise.reject(new Error("Computer network unavailable"))
        : command.op === "quality"
          ? quality()
          : egress()
    )
      .then((result) => console.log(JSON.stringify({ id, result })))
      .catch(() => console.log(JSON.stringify({ id, error: true })))
      .finally(() => {
        checking.delete(command.op);
        diagnostics.delete(controller);
      });
  } catch {
    /* Private bounded command channel. */
  }
});
console.log(JSON.stringify({ started: true, port }));
const status = setInterval(() => console.log(JSON.stringify(client.status())), 1000);
shutdown = () => {
  clearInterval(status);
  management?.stop();
  for (const diagnostic of diagnostics) diagnostic.abort();
  dns?.close();
  dnsExchange?.close();
  client.stop();
  void proxy.close().then(() => process.exit(0));
};
if (parentClosed) shutdown();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
