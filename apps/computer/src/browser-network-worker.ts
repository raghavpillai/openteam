import { BrowserNetworkClient } from "@openteam/plugin-sdk/browser-network/client";
import { createBrowserProxy } from "@openteam/plugin-sdk/browser-network/socks";
import { createQualityProbe } from "./browser-network-quality";
import { createEgressProbe } from "./browser-network-egress";
import { createInterface } from "node:readline";
import { startComputerDns, createDnsExchange } from "./computer-network-dns";
import { runOrdinaryProbe, probeComputerNetwork } from "./computer-network-probe";
import { startManagementDiscovery } from "./computer-network-management";
import { startNetworkConnectivity, probeNetworkFamily, applyNetworkFamilies } from "./network-connectivity";
import type { NetworkFamilyHealth } from "@openteam/plugin-sdk/browser-network/protocol";

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
    if (!["egress", "quality", "ipv4", "ipv6"].includes(probe.kind) || !probe.route?.epoch) throw new Error();
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
let connectivity: ReturnType<typeof startNetworkConnectivity> | undefined;
const statusView = () => ({ ...client.status(), routeEpoch: client.route?.epoch,
  connectivity: connectivity?.status() });
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
    const epoch = client.available() ? client.route?.epoch : undefined;
    if (epoch !== diagnosticEpoch) {
      diagnosticEpoch = epoch;
      for (const diagnostic of diagnostics) diagnostic.abort();
    }
    connectivity?.sync();
    console.log(JSON.stringify(statusView()));
  },
});
connectivity = startNetworkConnectivity({
  route: () => client.available() && client.route ? {
    epoch: client.route.epoch,
    sourceId: client.route.mode === "server" ? "server" : client.route.machineId!,
  } : null,
  probe: (family, signal) => probeNetworkFamily((host, port, life) => client.open(host, port, life), family, signal),
  verify: config.computerNetwork ? async (family, signal) => {
    const route = client.route;
    if (!route || !client.available()) throw new Error("Route unavailable");
    return await probeComputerNetwork(family, route, signal) as NetworkFamilyHealth;
  } : undefined,
  apply: config.computerNetwork ? applyNetworkFamilies : async () => {},
  changed: () => { dnsExchange?.syncRoute(); console.log(JSON.stringify(statusView())); },
  failed: () => process.exit(1),
});
const proxy = createBrowserProxy((host, port, signal) => client.open(host, port, signal));
const port = await proxy.listen(config.port);
dnsExchange = config.computerNetwork
  ? createDnsExchange(client, {
      routeKey: () => (client.available() ? (client.route?.epoch ?? null) : null),
      preferIPv6: () => connectivity?.status()?.ipv6.state === "working" &&
        connectivity?.status()?.ipv4.state !== "working",
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
const status = setInterval(() => console.log(JSON.stringify(statusView())), 1000);
shutdown = () => {
  clearInterval(status);
  management?.stop();
  for (const diagnostic of diagnostics) diagnostic.abort();
  dns?.close();
  dnsExchange?.close();
  client.stop();
  void Promise.all([connectivity?.close(), proxy.close()]).then(() => process.exit(0), () => process.exit(1));
};
if (parentClosed) shutdown();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
