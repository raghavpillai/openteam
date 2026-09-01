import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../client/openbot-api";
import { API_BASE } from "../client/http";
import { isOpenBotVersion } from "@openbot/contracts/version-compatibility";

const manualCommand = (targetVersion: string | null) =>
  targetVersion && isOpenBotVersion(targetVersion)
    ? `openbot update --version ${targetVersion}`
    : "openbot update";

const unavailableStatus = (targetVersion: string | null): OpenBotServerUpdateStatus => ({
  serverUrl: API_BASE,
  currentVersion: null,
  targetVersion,
  apiProtocolVersion: null,
  minimumClientVersion: null,
  maximumClientVersionExclusive: null,
  recommendedClientVersion: null,
  updateMethod: "manual",
  updaterAvailable: false,
  status: "unavailable",
  phase: null,
  message: "Run the update command on the server computer.",
  manualCommand: manualCommand(targetVersion),
});

export function useServerUpdateStatus(
  targetVersion: string | null,
  configuredSshTarget?: string | null
) {
  const [status, setStatus] = useState<OpenBotServerUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    if (!loaded.current) setLoading(true);
    const host = await (window.openbot?.updates
      .serverStatus({
        serverUrl: API_BASE,
        targetVersion,
        sshTarget:
          configuredSshTarget === undefined
            ? localStorage.getItem(`openbot.update.ssh.${API_BASE}`)
            : configuredSshTarget,
      })
      .catch(() => null) ?? Promise.resolve(null));
    // The native status call owns version discovery on Electron. Retain the
    // renderer request only for the browser-development fallback.
    const release = window.openbot ? null : await api.systemVersion().catch(() => null);
    const next = host ?? unavailableStatus(targetVersion);
    setStatus({
      ...next,
      currentVersion: release?.releaseVersion ?? next.currentVersion,
      apiProtocolVersion: release?.apiProtocolVersion ?? next.apiProtocolVersion,
      minimumClientVersion: release?.minimumClientVersion ?? next.minimumClientVersion,
      maximumClientVersionExclusive:
        release?.maximumClientVersionExclusive ?? next.maximumClientVersionExclusive,
      recommendedClientVersion: release?.recommendedClientVersion ?? next.recommendedClientVersion,
      targetVersion,
      manualCommand: manualCommand(targetVersion),
      message:
        release || next.currentVersion
          ? next.message
          : "This server does not report its release version. Update it before using a newer client.",
    });
    loaded.current = true;
    setLoading(false);
  }, [configuredSshTarget, targetVersion]);

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

  useEffect(
    () =>
      window.openbot?.updates.onServerProgress((next) => {
        setStatus(next);
        if (next.status === "updated") window.setTimeout(() => void refresh(), 750);
      }),
    [refresh]
  );

  return { status, loading, refresh };
}
