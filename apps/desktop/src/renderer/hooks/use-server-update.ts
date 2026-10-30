import {
  compareOpenTeamVersions,
  openTeamCompatibility,
} from "@openteam/contracts/version-compatibility";
import { useEffect, useState } from "react";
import { useServerUpdateStatus } from "./use-server-update-status";

/**
 * The desktop release and the server stack it pins: the stack follows the desktop, so a newer
 * desktop release updates first and the server then updates to that version.
 */
export function useServerUpdate() {
  const clientVersion = window.openteam?.versions.app ?? "0.0.0";
  const [clientUpdate, setClientUpdate] = useState<OpenTeamUpdateStatus | null>(null);
  const {
    status: server,
    loading: serverLoading,
    reconnecting: serverReconnecting,
    startedAt: serverStartedAt,
    observedAt: serverObservedAt,
    refresh: refreshServer,
    updateServer: requestServerUpdate,
  } = useServerUpdateStatus(clientVersion);

  useEffect(() => {
    let active = true;
    window.openteam?.updates
      .status()
      .then((value) => active && setClientUpdate(value))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => window.openteam?.updates.onClientProgress(setClientUpdate), []);

  const compatibility = openTeamCompatibility(
    clientVersion,
    server?.currentVersion ?? null,
    server?.apiProtocolVersion ?? null,
    {
      minimumClientVersion: server?.minimumClientVersion,
      maximumClientVersionExclusive: server?.maximumClientVersionExclusive,
      recommendedClientVersion: server?.recommendedClientVersion,
    }
  );
  // Compare with the installed desktop even if its update feed is unavailable.
  // A newer desktop release must not move the server ahead of this client.
  const serverTarget =
    compatibility === "server-update-required" ||
    (compatibility === "update-recommended" &&
      server?.currentVersion &&
      (compareOpenTeamVersions(clientVersion, server.currentVersion) ?? 0) > 0)
      ? clientVersion
      : null;
  const serverNeedsUpdate =
    !serverLoading &&
    Boolean(server) &&
    (compatibility === "server-update-required" || serverTarget !== null);

  const updateServer = async () => {
    if (!serverTarget) throw new Error("No newer server release is available.");
    await requestServerUpdate(serverTarget);
    await refreshServer();
  };

  return {
    clientVersion,
    clientUpdate,
    setClientUpdate,
    server,
    serverLoading,
    serverReconnecting,
    serverStartedAt,
    serverObservedAt,
    refreshServer,
    compatibility,
    serverTarget,
    serverNeedsUpdate,
    serverUpdating: server?.status === "updating",
    updateServer,
  };
}
