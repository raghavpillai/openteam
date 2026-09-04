import { openTeamCompatibility } from "@openteam/contracts/version-compatibility";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useServerUpdateStatus } from "../../hooks/use-server-update-status";
import { OPENTEAM_DEEP_LINK_EVENT } from "../../lib/app-deep-links";

export const VERSION_MISMATCH_TOAST_ID = "openteam-version-mismatch";

const openUpdates = () =>
  window.dispatchEvent(
    new CustomEvent(OPENTEAM_DEEP_LINK_EVENT, {
      detail: { url: "openteam://app/v1/settings?id=update-status" },
    })
  );

export function VersionMismatchBanner({ showReview = true }: { showReview?: boolean }) {
  const clientVersion = window.openteam?.versions.app ?? "0.0.1";
  const { status, loading, refresh } = useServerUpdateStatus(clientVersion);
  const [clientUpdate, setClientUpdate] = useState<OpenTeamUpdateStatus | null>(null);
  const acting = useRef(false);

  useEffect(() => {
    let active = true;
    void window.openteam?.updates
      .status()
      .then((next) => active && setClientUpdate(next))
      .catch(() => undefined);
    const unsubscribe = window.openteam?.updates.onClientProgress((next) => {
      if (active) setClientUpdate(next);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const compatibility = status
    ? openTeamCompatibility(clientVersion, status.currentVersion, status.apiProtocolVersion, {
        minimumClientVersion: status.minimumClientVersion,
        maximumClientVersionExclusive: status.maximumClientVersionExclusive,
        recommendedClientVersion: status.recommendedClientVersion,
      })
    : null;

  const updateDesktop = useCallback(async () => {
    if (!window.openteam) throw new Error("Desktop updates are unavailable");
    let update = clientUpdate ?? (await window.openteam.updates.status());
    if (update.status === "downloaded") {
      await window.openteam.updates.installClient();
      return;
    }
    if (update.status !== "available") {
      update = await window.openteam.updates.check();
      setClientUpdate(update);
    }
    if (update.status !== "available") {
      throw new Error(update.message || "No compatible desktop release is currently published");
    }
    await window.openteam.updates.openDownload();
  }, [clientUpdate]);

  const runDirectAction = useCallback(async () => {
    if (!status || !compatibility || acting.current) return;
    if (status.status === "updating") {
      openUpdates();
      return;
    }
    acting.current = true;
    toast.loading("Starting the compatibility update…", {
      id: VERSION_MISMATCH_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
    });
    try {
      if (compatibility === "client-update-required") {
        await updateDesktop();
      } else if (status.updaterAvailable) {
        if (!window.openteam) throw new Error("Server updates are unavailable");
        await window.openteam.updates.updateServer({
          serverUrl: status.serverUrl,
          targetVersion: compatibility === "server-update-required" ? clientVersion : null,
          sshTarget: localStorage.getItem(`openteam.update.ssh.${status.serverUrl}`),
        });
        await refresh();
      } else {
        const command =
          compatibility === "server-update-required"
            ? `openteam update --version ${clientVersion}`
            : "openteam update";
        await navigator.clipboard.writeText(command);
        toast.success("Server update command copied", { id: VERSION_MISMATCH_TOAST_ID });
        return;
      }
      toast.success("Update started", { id: VERSION_MISMATCH_TOAST_ID });
    } catch (error) {
      toast.error("The update could not be started", {
        id: VERSION_MISMATCH_TOAST_ID,
        description: clientErrorMessage(error, "Try again from Update settings"),
        action: { label: "View updates", onClick: openUpdates },
        duration: Number.POSITIVE_INFINITY,
      });
    } finally {
      acting.current = false;
    }
  }, [clientVersion, compatibility, refresh, status, updateDesktop]);

  useEffect(() => {
    if (loading || !status || !compatibility) return;
    if (compatibility === "compatible" || compatibility === "update-recommended") {
      toast.dismiss(VERSION_MISMATCH_TOAST_ID);
      return;
    }

    const title =
      status.status === "updating"
        ? "Server update in progress"
        : compatibility === "server-update-required"
          ? "Server update required"
          : compatibility === "client-update-required"
            ? "Desktop update required"
            : "Version compatibility warning";
    const guidance =
      status.status === "updating"
        ? `${status.message ?? "OpenTeam is updating the server."} The update continues if Desktop closes.`
        : compatibility === "server-update-required"
          ? "This server cannot support the installed Desktop version. Update the server to continue."
          : compatibility === "client-update-required"
            ? "This Desktop version is outside the range supported by the server. Update Desktop to continue."
            : "Desktop could not verify compatibility with this server. Review the available updates.";
    const versions = `Desktop ${clientVersion} · Server ${status.currentVersion ?? "not reported"}`;
    const actionLabel =
      status.status === "updating"
        ? "View progress"
        : compatibility === "client-update-required"
          ? "Update Desktop"
          : status.updaterAvailable
            ? "Update server"
            : "Copy command";

    toast.warning(title, {
      id: VERSION_MISMATCH_TOAST_ID,
      description: `${guidance} ${versions}`,
      duration: Number.POSITIVE_INFINITY,
      action: { label: actionLabel, onClick: () => void runDirectAction() },
      ...(showReview ? { cancel: { label: "Details", onClick: openUpdates } } : {}),
    });
  }, [clientVersion, compatibility, loading, runDirectAction, showReview, status]);

  return null;
}
