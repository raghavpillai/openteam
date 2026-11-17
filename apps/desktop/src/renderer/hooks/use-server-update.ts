import { openTeamCompatibility } from "@openteam/contracts/version-compatibility";
import { useEffect, useState } from "react";
import { useServerUpdateStatus } from "./use-server-update-status";
import { serverUpdateTarget } from "../lib/update-plan";
import { useUpdateQueue } from "./use-update-queue";

/** Desktop and server may update separately; the signed host updater verifies each release. */
export function useServerUpdate() {
  const queue = useUpdateQueue();
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
  } = useServerUpdateStatus(clientVersion, queue.state?.status === "running");

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
  const serverTarget = serverUpdateTarget(
    clientVersion,
    clientUpdate?.status === "error" ? null : (clientUpdate?.latestVersion ?? null),
    server?.currentVersion ?? null
  );
  const serverNeedsUpdate = !serverLoading && Boolean(server) && serverTarget !== null;

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
