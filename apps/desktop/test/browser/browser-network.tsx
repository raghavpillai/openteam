import React from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../src/renderer/client/openteam-api";
import { BrowserNetworkSettings } from "../../src/renderer/components/openteam/settings/browser-network";
import "../../src/renderer/styles.css";
const fixture = (window as any).networkFixture;
(window as any).refreshNetworkFixture = refreshRoute;
function refreshRoute() {
  const source =
    fixture.view.settings.mode === "ranked"
      ? fixture.view.settings.sourceOrder.find(
          (id: string) =>
            id === "server" ||
            fixture.view.devices.some(
              (d: any) => d.machineId === id && d.connected && d.enabled && d.sharingAllowed
            )
        )
      : fixture.view.settings.mode === "device"
        ? fixture.view.settings.machineId
        : "server";
  fixture.view.runtime.state =
    source === "server"
      ? "server"
      : fixture.view.devices.some((d: any) => d.machineId === source && d.sharingAllowed)
        ? "ready"
        : "waiting_for_device";
  fixture.view.runtime.routeEpoch = `${fixture.view.settings.revision}-${source}`;
  fixture.view.runtime.activeMachineId = fixture.view.runtime.state === "ready" ? source : null;
}
refreshRoute();
api.browserNetwork = async () => {
  refreshRoute();
  if (fixture.protocols) fixture.view.runtime.connectivity = {
    epoch: fixture.staleProtocols ? "obsolete" : fixture.view.runtime.routeEpoch,
    sourceId: fixture.wrongProtocolSource ? "other" : fixture.view.runtime.activeMachineId ?? "server",
    checkedAt: "2026-11-10T03:15:00.000Z",
    ipv4: { state: fixture.protocols[0] },
    ipv6: { state: fixture.protocols[1], ...(fixture.protocols[1] === "unavailable" ? { reason: "connect_failed" } : {}) },
  };
  return structuredClone(fixture.view);
};
api.browserNetworkQuality = async () => {
  fixture.qualityChecks = (fixture.qualityChecks ?? 0) + 1;
  if (fixture.failQuality) throw new Error("Test unavailable");
  return {
    epoch: fixture.view.runtime.routeEpoch,
    sourceId: fixture.view.runtime.activeMachineId ?? "server",
    checkedAt: new Date().toISOString(),
    latencyMs: 42,
    downloadMbps: 28.4,
    uploadMbps: 9.2,
    downloadBytes: 1048576,
    uploadBytes: 262144,
  };
};
api.browserNetworkEgress = async () => {
  fixture.probes = (fixture.probes ?? 0) + 1;
  if (fixture.failProbe) throw new Error("Probe unavailable");
  const source = fixture.view.runtime.activeMachineId ?? "server";
  return {
    epoch: fixture.view.runtime.routeEpoch,
    sourceId: source,
    ip: source === "home" ? "203.0.113.10" : source === "office" ? "198.51.100.20" : "192.0.2.30",
    location:
      source === "home"
        ? "New York, United States"
        : source === "office"
          ? "Boston, United States"
          : "Ashburn, United States",
    checkedAt: new Date().toISOString(),
  };
};
api.updateBrowserNetwork = async (input) => {
  if (input.expectedRevision !== fixture.view.settings.revision)
    throw new Error("The browser connection changed. Refresh settings and try again.");
  fixture.mutations.push(input);
  fixture.view.settings = {
    ...fixture.view.settings,
    mode: input.mode,
    machineId: input.machineId,
    revision: input.expectedRevision + 1,
    sourceOrder: input.sourceOrder ?? fixture.view.settings.sourceOrder ?? [],
  };
  refreshRoute();
  return structuredClone(fixture.view);
};
api.retryBrowserNetwork = async () => structuredClone(fixture.view);
(window as any).openteam = {
  auth: {
    machineStatus: async () => ({
      machineId: "home",
      configured: true,
      connected: true,
      error: null,
    }),
  },
  computer: {
    network: async () => structuredClone(fixture.sharing),
    shareNetwork: async (enabled: boolean) => {
      fixture.permissionChanges.push(enabled);
      fixture.sharing.sharingAllowed = enabled;
      fixture.view.devices[0].sharingAllowed = enabled;
      fixture.view.devices[0].supported = true;
      if (
        enabled &&
        !fixture.view.settings.sourceOrder.includes(fixture.view.devices[0].machineId)
      ) {
        const order = fixture.view.settings.sourceOrder;
        const at =
          order.length === 1 || order.at(-1) === "server" ? order.indexOf("server") : order.length;
        order.splice(at, 0, fixture.view.devices[0].machineId);
        fixture.view.settings.revision++;
      }
      refreshRoute();
      return structuredClone(fixture.sharing);
    },
  },
};
createRoot(document.getElementById("root")!).render(<BrowserNetworkSettings />);
