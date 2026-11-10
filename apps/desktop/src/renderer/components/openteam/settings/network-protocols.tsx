import {
  currentConnectivity,
  type BrowserNetworkView,
  type NetworkFamilyHealth,
} from "@openteam/contracts/browser-network";

const label = (health?: NetworkFamilyHealth) =>
  health?.state === "working"
    ? "Working"
    : health?.state === "unavailable"
      ? "Unavailable"
      : health
        ? "Checking…"
        : "Not checked";
export function NetworkProtocols({ view }: { view: BrowserNetworkView | null }) {
  const live = view && ["ready", "server"].includes(view.runtime.state);
  const connectivity = live
    ? currentConnectivity(
        view.runtime.connectivity,
        view.runtime.routeEpoch,
        view.runtime.state === "server" ? "server" : view.runtime.activeMachineId
      )
    : undefined;
  const families = ["ipv4", "ipv6"] as const;
  return (
    <div className="bn-protocols" role="group" aria-label="Internet protocols">
      <span className="bn-protocol-title">Protocols</span>
      <span className="bn-protocol-values">
        {families.map((family, index) => (
          <span key={family} className={`bn-protocol ${connectivity?.[family].state ?? "unknown"}`}>
            <span className="bn-status-dot" aria-hidden="true" />
            <span>IPv{index === 0 ? "4" : "6"}</span>
            <span className="bn-protocol-state">{label(connectivity?.[family])}</span>
          </span>
        ))}
      </span>
    </div>
  );
}
