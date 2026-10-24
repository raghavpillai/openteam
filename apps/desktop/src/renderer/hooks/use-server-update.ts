import {
  compareOpenTeamVersions,
  openTeamCompatibility,
} from "@openteam/contracts/version-compatibility";
import { useEffect, useMemo, useState } from "react";
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
    refresh: refreshServer,
    updateServer: requestServerUpdate,
  } = useServerUpdateStatus(clientUpdate?.latestVersion ?? clientVersion);

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
  const newerDesktopReleaseAvailable =
    Boolean(clientUpdate?.latestVersion) &&
    (compareOpenTeamVersions(clientUpdate?.latestVersion ?? clientVersion, clientVersion) ?? 0) > 0;
  const serverTarget = useMemo(() => {
    if (compatibility === "server-update-required") return clientVersion;
    if (compatibility === "unknown") return null;
    if (newerDesktopReleaseAvailable) return null;
    if (!server?.currentVersion || !clientUpdate?.latestVersion) return null;
    return (compareOpenTeamVersions(clientUpdate.latestVersion, server.currentVersion) ?? 0) > 0
      ? clientUpdate.latestVersion
      : null;
  }, [
    clientUpdate?.latestVersion,
    clientVersion,
    compatibility,
    newerDesktopReleaseAvailable,
    server?.currentVersion,
  ]);
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
    refreshServer,
    compatibility,
    serverTarget,
    serverNeedsUpdate,
    serverUpdating: server?.status === "updating",
    updateServer,
  };
}
