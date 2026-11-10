import { ChevronRight } from "lucide-react";
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
const reason = (health?: NetworkFamilyHealth) =>
  health?.reason === "tls_failed"
    ? "Secure connection could not be verified."
    : health?.reason === "path_failed"
      ? "The bot computer could not use this protocol."
      : health?.reason === "connect_failed"
        ? "The selected exit could not connect."
        : health?.state === "working"
          ? "Verified through the selected exit."
          : health?.state === "unavailable"
            ? "No working connection was found."
            : "Waiting for a connection check.";

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
  const working = families.filter((family) => connectivity?.[family].state === "working");
  return (
    <details className="bn-protocols" key={view?.runtime.routeEpoch}>
      <summary aria-label={`Internet protocol details. IPv4 ${label(connectivity?.ipv4)}. IPv6 ${label(connectivity?.ipv6)}.`}>
        <span className="bn-protocol-title">
          <ChevronRight size={12} aria-hidden="true" />
          Protocols
        </span>
        <span className="bn-protocol-values">
          {families.map((family, index) => (
            <span
              key={family}
              className={`bn-protocol ${connectivity?.[family].state ?? "unknown"}`}
            >
              <span className="bn-status-dot" aria-hidden="true" />
              <span>IPv{index === 0 ? "4" : "6"}</span>
              <span className="bn-protocol-state">{label(connectivity?.[family])}</span>
            </span>
          ))}
        </span>
      </summary>
      <div className="bn-protocol-details">
        <p>
          {working.length === 2
            ? "Both protocols are available. Apps choose automatically."
            : working.length === 1
              ? working[0] === "ipv4"
                ? "IPv4 is available. Apps use the working connection."
                : "IPv6 is available. IPv4-only sites may be unreachable."
              : connectivity &&
                  families.every((family) => connectivity[family].state === "unavailable")
                ? "Neither protocol could reach the internet. Check the selected exit’s connection."
                : live
                  ? connectivity
                    ? "Checking the selected exit’s internet connection."
                    : "Protocol checks have not been reported yet."
                  : "Connect an exit to check its protocols."}
        </p>
        <dl>
          {families.map((family, index) => (
            <div key={family}>
              <dt>IPv{index === 0 ? "4" : "6"}</dt>
              <dd>{reason(connectivity?.[family])}</dd>
            </div>
          ))}
        </dl>
        {connectivity?.checkedAt && (
          <p className="bn-protocol-checked">
            Checked{" "}
            <time dateTime={connectivity.checkedAt}>
              {new Date(connectivity.checkedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </p>
        )}
      </div>
    </details>
  );
}
