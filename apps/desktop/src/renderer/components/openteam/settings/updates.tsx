import { TriangleAlert } from "lucide-react";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useState } from "react";
import { useServerUpdate } from "../../../hooks/use-server-update";
import { requestDesktopUpdateRestart } from "../../../lib/desktop-update";
import { LoadingOrb } from "../../ui/loading-orb";
import { ServerUpdateSettings } from "./server-update";
import { SectionLabel, SettingsGroup, SettingsLink, SettingsRow } from "./ui";

const primaryButton =
  "inline-flex h-9 items-center gap-2 rounded-[9px] bg-black px-3 text-[13px] text-white enabled:hover:opacity-80 disabled:bg-black/[0.07] disabled:text-foreground disabled:opacity-50 dark:bg-white dark:text-black dark:disabled:bg-white/[0.09] dark:disabled:text-foreground";
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
  const update = useServerUpdate();
  const {
    clientVersion,
    clientUpdate,
    setClientUpdate,
    server,
    serverLoading,
    refreshServer,
    compatibility,
  } = update;
  const [actionError, setActionError] = useState<string | null>(null);

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
        requestDesktopUpdateRestart(clientUpdate);
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

  const mismatchMessage =
    compatibility === "server-update-required"
      ? `Server ${server?.currentVersion} cannot support desktop ${clientVersion}. Update the connected server below.`
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
          {update.serverNeedsUpdate
            ? "Server update available. You can keep working."
            : "Your server is newer than this desktop."}{" "}
          <SettingsLink anchor={update.serverNeedsUpdate ? "server-update" : "update-status"}>
            View update
          </SettingsLink>
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
                  <LoadingOrb aria-hidden size={14} />
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
                {clientUpdate?.status === "checking" ? <LoadingOrb aria-hidden size={14} /> : null}
                {clientUpdate?.status === "checking" ? "Checking…" : "Check for Updates"}
              </button>
            )
          }
          description={
            clientUpdate?.status === "available"
              ? (clientUpdate.message ?? `Desktop ${clientUpdate.latestVersion} is available`)
              : clientUpdate?.status === "up-to-date"
                ? (clientUpdate.message ?? "You’re up to date")
                : ["downloading", "downloaded", "installing"].includes(clientUpdate?.status ?? "")
                  ? clientUpdate?.message
                  : clientUpdate?.status === "error"
                    ? clientUpdateFailure(clientUpdate)
                    : "Check for a newer desktop version."
          }
          title={`Desktop app ${clientVersion}`}
        />
      </SettingsGroup>
      {actionError ? (
        <p className="mt-3 px-2 text-[12.5px] text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}
      <ServerUpdateSettings update={update} />
    </>
  );
}
