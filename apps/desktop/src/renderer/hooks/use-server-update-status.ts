import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../client/openteam-api";
import { API_BASE } from "../client/http";
import { isOpenTeamVersion } from "@openteam/contracts/version-compatibility";

const manualCommand = (targetVersion: string | null) =>
  targetVersion && isOpenTeamVersion(targetVersion)
    ? `openteam update --version ${targetVersion}`
    : "openteam update";

const unavailableStatus = (targetVersion: string | null): OpenTeamServerUpdateStatus => ({
  serverUrl: API_BASE,
  currentVersion: null,
  targetVersion,
  apiProtocolVersion: null,
  minimumClientVersion: null,
  maximumClientVersionExclusive: null,
  recommendedClientVersion: null,
  updaterAvailable: false,
  status: "unavailable",
  phase: null,
  message: "Run openteam update once on this server to enable updates from the app.",
  manualCommand: manualCommand(targetVersion),
  jobId: null,
  safeToCloseDesktop: false,
});

export function useServerUpdateStatus(targetVersion: string | null) {
  const [status, setStatus] = useState<OpenTeamServerUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    if (!loaded.current) setLoading(true);
    const [release, update] = await Promise.all([
      api.systemVersion().catch(() => null),
      api.serverUpdateStatus().catch(() => null),
    ]);
    setStatus((previous) => {
      // Maintenance restarts the API. Keep progress and versions until it reconnects.
      if (!release && !update && previous) return previous;
      const next = { ...unavailableStatus(targetVersion), ...update };
      return {
        ...next,
        currentVersion: release?.releaseVersion ?? previous?.currentVersion ?? null,
        apiProtocolVersion: release?.apiProtocolVersion ?? previous?.apiProtocolVersion ?? null,
        minimumClientVersion: release?.minimumClientVersion ?? null,
        maximumClientVersionExclusive: release?.maximumClientVersionExclusive ?? null,
        recommendedClientVersion: release?.recommendedClientVersion ?? null,
        targetVersion: update?.targetVersion ?? targetVersion,
        message:
          release || previous?.currentVersion
            ? next.message
            : "This server does not report its release version. Update it before using a newer client.",
      };
    });
    loaded.current = true;
    setLoading(false);
  }, [targetVersion]);

  const updateServer = useCallback(async (version: string) => {
    const next = await api.updateServer(version);
    setStatus((previous) => ({ ...unavailableStatus(version), ...previous, ...next }));
  }, []);

  useEffect(() => {
    void refresh();
    const refreshOnFocus = () => void refresh();
    window.addEventListener("focus", refreshOnFocus);
    const interval = window.setInterval(refreshOnFocus, 60_000);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    if (status?.status !== "updating") return;
    const interval = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(interval);
  }, [refresh, status?.status]);

  return { status, loading, refresh, updateServer };
}
