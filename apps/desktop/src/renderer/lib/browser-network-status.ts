import { currentConnectivity, type BrowserNetworkView } from "@openteam/contracts/browser-network";

export function browserNetworkLabel(view: BrowserNetworkView) {
  const name =
    view.devices.find(
      (d) => d.machineId === (view.runtime.activeMachineId ?? view.settings.machineId)
    )?.label ?? "selected computer";
  const health = currentConnectivity(view.runtime.connectivity, view.runtime.routeEpoch,
    view.runtime.state === "server" ? "server" : view.runtime.activeMachineId);
  if (["ready", "server"].includes(view.runtime.state) && health?.ipv4.state === "unavailable" && health.ipv6.state === "unavailable")
    return `No internet through ${view.runtime.state === "server" ? "the server connection" : name}`;
  switch (view.runtime.state) {
    case "server":
      return view.settings.mode === "ranked"
        ? `Using the server connection · ${view.settings.sourceOrder[0] === "server" ? "Ranked connections" : "Ranked fallback"}`
        : "Using the server connection";
    case "ready":
      return `Using ${name}${view.settings.mode === "ranked" ? " · Ranked connections" : ""}`;
    case "waiting_for_device":
      return `Waiting for ${name}; computer networking is paused`;
    case "applying":
      return "Changing computer connection…";
    case "update_required":
      return "Computer connection unavailable; update or reconnect the computer runtime";
    default:
      return "Computer network unavailable";
  }
}
