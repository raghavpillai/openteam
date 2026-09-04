import { Check, Clipboard, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  compareOpenTeamVersions,
  openTeamCompatibility,
} from "@openteam/contracts/version-compatibility";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "../../../client/http";
import { useServerUpdateStatus } from "../../../hooks/use-server-update-status";
import { SectionLabel, SettingsGroup, SettingsRow } from "./ui";

const primaryButton =
  "inline-flex h-9 items-center gap-2 rounded-[9px] bg-black px-3 text-[13px] text-white hover:opacity-80 disabled:opacity-50 dark:bg-white dark:text-black";
const secondaryButton =
  "inline-flex h-9 items-center gap-2 rounded-[9px] bg-black/[0.04] px-3 text-[13px] hover:bg-black/[0.07] disabled:opacity-50 dark:bg-white/[0.07] dark:hover:bg-white/[0.1]";

const clientUpdateFailure = (status: OpenTeamUpdateStatus): string => {
  const summary =
    status.failureKind === "signature-invalid"
      ? "The downloaded update failed signature verification and was not installed."
      : status.failureKind === "feed-malformed"
        ? "The update server returned an invalid release manifest."
        : status.failureKind === "feed-http-status"
          ? "The update server refused the request."
          : status.failureKind === "service-unavailable"
            ? "The update service is currently unreachable."
            : status.failureKind === "download-failed"
              ? "The update could not be downloaded."
              : status.failureKind === "apply-unsupported"
                ? "The downloaded update cannot be installed on this platform."
                : "The desktop update failed.";
  return status.message && status.message !== summary ? `${summary} ${status.message}` : summary;
};

export default function UpdatesSettings() {
  const clientVersion = window.openteam?.versions.app ?? "0.0.1";
  const [clientUpdate, setClientUpdate] = useState<OpenTeamUpdateStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sshTarget, setSshTarget] = useState(
    () => localStorage.getItem(`openteam.update.ssh.${API_BASE}`) ?? ""
  );
  const proposedServerTarget = clientUpdate?.latestVersion ?? clientVersion;
  const {
    status: server,
    loading: serverLoading,
    refresh: refreshServer,
  } = useServerUpdateStatus(proposedServerTarget, sshTarget);

  const changeSshTarget = (value: string) => {
    setSshTarget(value);
    const normalized = value.trim();
    if (normalized) localStorage.setItem(`openteam.update.ssh.${API_BASE}`, normalized);
    else localStorage.removeItem(`openteam.update.ssh.${API_BASE}`);
  };

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
  const serverUpdating = server?.status === "updating";
  const clientNeedsUpdate =
    compatibility === "client-update-required" ||
    ["available", "downloading", "downloaded", "installing"].includes(clientUpdate?.status ?? "");

  const check = async () => {
    setActionError(null);
    setClientUpdate((current) =>
      current ? { ...current, status: "checking", message: null } : current
    );
    try {
      const next = await window.openteam?.updates.check();
      if (next) setClientUpdate(next);
      await refreshServer();
    } catch (error) {
      setActionError(clientErrorMessage(error, "Could not check for updates"));
    }
  };

  const updateClient = async () => {
    setActionError(null);
    try {
      if (clientUpdate?.status === "downloaded") {
        await window.openteam?.updates.installClient();
        return;
      }
      if (["downloading", "installing"].includes(clientUpdate?.status ?? "")) return;
      let next = clientUpdate;
      if (next?.status !== "available") {
        next = (await window.openteam?.updates.check()) ?? next;
        if (next) setClientUpdate(next);
      }
      if (next?.status === "available") await window.openteam?.updates.openDownload();
      else throw new Error("No newer desktop release is currently published");
    } catch (error) {
      setActionError(clientErrorMessage(error, "Could not open the client update"));
    }
  };

  const updateServer = async () => {
    if (!serverNeedsUpdate || !window.openteam) return;
    setActionError(null);
    try {
      await window.openteam.updates.updateServer({
        serverUrl: API_BASE,
        targetVersion: serverTarget,
        sshTarget: sshTarget.trim() || null,
      });
      await refreshServer();
    } catch (error) {
      setActionError(clientErrorMessage(error, "The server update failed"));
    }
  };

  const copyServerCommand = async () => {
    if (!server) return;
    setActionError(null);
    try {
      await navigator.clipboard.writeText(
        serverTarget ? `openteam update --version ${serverTarget}` : "openteam update"
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      setActionError(clientErrorMessage(error, "Could not copy the update command"));
    }
  };

  const mismatchMessage =
    compatibility === "server-update-required"
      ? `Server ${server?.currentVersion} cannot support desktop ${clientVersion}. Update the server and computer.`
      : compatibility === "client-update-required"
        ? `Desktop ${clientVersion} is outside server ${server?.currentVersion}'s supported range. Update the desktop app.`
        : compatibility === "unknown" && !serverLoading
          ? "OpenTeam could not verify that the desktop and server releases match. Update the server first if it does not report a version."
          : null;

  return (
    <>
      {mismatchMessage ? (
        <div
          className="mb-6 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3.5 py-3 text-[12.5px] text-amber-950 dark:text-amber-100"
          role="alert"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{mismatchMessage}</span>
        </div>
      ) : null}

      {compatibility === "update-recommended" ? (
        <p className="mb-4 px-2 text-[12.5px] text-muted-foreground">
          Desktop {clientVersion} and server {server?.currentVersion} are compatible. Updating is
          recommended, but you can keep working.
        </p>
      ) : null}

      <SectionLabel>OpenTeam Updates</SectionLabel>
      <SettingsGroup>
        <SettingsRow
          anchors={["update-status", "automatic-updates"]}
          control={
            clientNeedsUpdate ? (
              <button
                className={primaryButton}
                disabled={["downloading", "installing"].includes(clientUpdate?.status ?? "")}
                onClick={() => void updateClient()}
                type="button"
              >
                {["downloading", "installing"].includes(clientUpdate?.status ?? "") ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : null}
                {clientUpdate?.status === "downloaded"
                  ? "Restart to update"
                  : clientUpdate?.status === "downloading"
                    ? `Downloading ${Math.round(clientUpdate.progress ?? 0)}%`
                    : clientUpdate?.status === "installing"
                      ? "Restarting…"
                      : "Update desktop"}
              </button>
            ) : (
              <button
                className={secondaryButton}
                disabled={clientUpdate?.status === "checking"}
                onClick={() => void check()}
                type="button"
              >
                {clientUpdate?.status === "checking" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : null}
                {clientUpdate?.status === "checking" ? "Checking…" : "Check for Updates"}
              </button>
            )
          }
          description={
            clientUpdate?.status === "available"
              ? `Desktop ${clientUpdate.latestVersion} is available`
              : clientUpdate?.status === "up-to-date"
                ? (clientUpdate.message ?? "You’re up to date")
                : ["downloading", "downloaded", "installing"].includes(clientUpdate?.status ?? "")
                  ? clientUpdate?.message
                  : clientUpdate?.status === "error"
                    ? clientUpdateFailure(clientUpdate)
                    : "The Electron desktop application"
          }
          title={`Desktop app ${clientVersion}`}
        />
        <SettingsRow
          anchors={["server-update"]}
          control={
            serverNeedsUpdate ? (
              server?.updaterAvailable ? (
                <button
                  className={primaryButton}
                  disabled={serverUpdating}
                  onClick={() => void updateServer()}
                  type="button"
                >
                  {serverUpdating ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                  {serverUpdating
                    ? "Updating…"
                    : serverTarget
                      ? `Update to ${serverTarget}`
                      : "Update server"}
                </button>
              ) : (
                <button
                  className={secondaryButton}
                  onClick={() => void copyServerCommand()}
                  type="button"
                >
                  {copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
                  {copied ? "Copied" : "Copy server command"}
                </button>
              )
            ) : (
              <button
                className={secondaryButton}
                disabled={serverLoading || serverUpdating}
                onClick={() => void refreshServer()}
                type="button"
              >
                {serverLoading || serverUpdating ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : null}
                {serverUpdating ? "Updating…" : "Check server"}
              </button>
            )
          }
          description={
            serverUpdating
              ? `${server.message ?? "Updating the managed OpenTeam stack"}${
                  server.safeToCloseDesktop
                    ? " The update will continue if you close the desktop app."
                    : ""
                }`
              : server?.currentVersion
                ? server.updaterAvailable
                  ? "Server stack, worker, database migrations, and computer container"
                  : "Run the update command on the server computer"
                : (server?.message ?? "Checking the server release")
          }
          title={`Server stack ${server?.currentVersion ?? "unknown"}`}
        />
        {server?.updateMethod !== "local" ? (
          <SettingsRow
            anchors={["server-update"]}
            control={
              <input
                aria-label="SSH destination"
                autoCapitalize="none"
                autoCorrect="off"
                className="h-9 w-48 rounded-[9px] border border-black/10 bg-transparent px-3 text-[13px] outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/35"
                onChange={(event) => changeSshTarget(event.target.value)}
                placeholder={`user@${new URL(API_BASE).hostname}`}
                spellCheck={false}
                value={sshTarget}
              />
            }
            description={
              server?.updateMethod === "ssh"
                ? "Uses your operating system SSH agent and known_hosts; passwords are never stored. The server update continues after it starts, even if Desktop closes"
                : "Enter an SSH host already configured on this computer to enable one-click remote updates"
            }
            title="Remote server access"
          />
        ) : null}
      </SettingsGroup>
      {actionError ? (
        <p className="mt-3 px-2 text-[12.5px] text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}
      {serverUpdating ? (
        <p aria-live="polite" className="mt-3 px-2 text-[12px] text-muted-foreground">
          {server.message}
        </p>
      ) : null}
    </>
  );
}
