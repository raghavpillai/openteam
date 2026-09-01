import { Check, CircleAlert, Clipboard, LoaderCircle } from "lucide-react";
import { openBotCompatibility } from "@openbot/contracts/version-compatibility";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { useEffect, useState } from "react";
import { useServerUpdateStatus } from "../../hooks/use-server-update-status";
import { OPENBOT_DEEP_LINK_EVENT } from "../../lib/app-deep-links";

const openUpdates = () =>
  window.dispatchEvent(
    new CustomEvent(OPENBOT_DEEP_LINK_EVENT, {
      detail: { url: "grokbot://app/v1/settings?id=update-status" },
    })
  );

export function VersionMismatchBanner({ showReview = true }: { showReview?: boolean }) {
  const clientVersion = window.openbot?.versions.app ?? "0.1.0";
  const { status, loading, refresh } = useServerUpdateStatus(clientVersion);
  const [clientUpdate, setClientUpdate] = useState<OpenBotUpdateStatus | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (showReview) return;
    let active = true;
    void window.openbot?.updates
      .status()
      .then((next) => active && setClientUpdate(next))
      .catch(() => undefined);
    const unsubscribe = window.openbot?.updates.onClientProgress((next) => {
      if (active) setClientUpdate(next);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [showReview]);

  if (loading || !status) return null;

  const compatibility = openBotCompatibility(
    clientVersion,
    status.currentVersion,
    status.apiProtocolVersion,
    {
      minimumClientVersion: status.minimumClientVersion,
      maximumClientVersionExclusive: status.maximumClientVersionExclusive,
      recommendedClientVersion: status.recommendedClientVersion,
    }
  );
  if (compatibility === "compatible" || compatibility === "update-recommended") return null;

  const updateDesktop = async () => {
    if (!window.openbot) throw new Error("Desktop updates are unavailable");
    let update = clientUpdate ?? (await window.openbot.updates.status());
    if (update.status === "downloaded") {
      await window.openbot.updates.installClient();
      return;
    }
    if (update.status !== "available") {
      update = await window.openbot.updates.check();
      setClientUpdate(update);
    }
    if (update.status !== "available") {
      throw new Error(update.message || "No compatible desktop release is currently published");
    }
    await window.openbot.updates.openDownload();
  };

  const runDirectAction = async () => {
    if (!window.openbot || acting) return;
    setActing(true);
    setActionError(null);
    try {
      if (compatibility === "client-update-required") {
        await updateDesktop();
      } else if (status.updaterAvailable) {
        await window.openbot.updates.updateServer({
          serverUrl: status.serverUrl,
          targetVersion: compatibility === "server-update-required" ? clientVersion : null,
          sshTarget: localStorage.getItem(`openbot.update.ssh.${status.serverUrl}`),
        });
        await refresh();
      } else {
        const command =
          compatibility === "server-update-required"
            ? `openbot update --version ${clientVersion}`
            : "openbot update";
        await navigator.clipboard.writeText(command);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      }
    } catch (error) {
      setActionError(clientErrorMessage(error, "The update could not be started"));
    } finally {
      setActing(false);
    }
  };

  const message =
    compatibility === "server-update-required"
      ? `Server ${status.currentVersion} cannot support desktop ${clientVersion}. Update the server to continue.`
      : compatibility === "client-update-required"
        ? `Desktop ${clientVersion} is outside server ${status.currentVersion}'s supported range. Update the desktop app.`
        : "The server and desktop release compatibility could not be verified. Update the server first if it cannot report a release, then update the desktop if versions still differ.";

  return (
    <div
      className={`${showReview ? "" : "absolute inset-x-0 top-0 z-10 "}flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-950 dark:text-amber-100`}
      role="alert"
    >
      <CircleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {message}
        {actionError ? <span className="ml-1 font-medium">{actionError}</span> : null}
      </span>
      {showReview ? (
        <button
          className="shrink-0 rounded-md bg-amber-950 px-2.5 py-1 font-medium text-white hover:opacity-85 dark:bg-amber-100 dark:text-amber-950"
          onClick={openUpdates}
          type="button"
        >
          Review update
        </button>
      ) : (
        <button
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-950 px-2.5 py-1 font-medium text-white hover:opacity-85 disabled:opacity-60 dark:bg-amber-100 dark:text-amber-950"
          disabled={acting || ["downloading", "installing"].includes(clientUpdate?.status ?? "")}
          onClick={() => void runDirectAction()}
          type="button"
        >
          {acting || ["downloading", "installing"].includes(clientUpdate?.status ?? "") ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : copied ? (
            <Check className="size-3" />
          ) : compatibility !== "client-update-required" && !status.updaterAvailable ? (
            <Clipboard className="size-3" />
          ) : null}
          {compatibility === "client-update-required"
            ? clientUpdate?.status === "downloaded"
              ? "Restart to update"
              : clientUpdate?.status === "downloading"
                ? `Downloading ${Math.round(clientUpdate.progress ?? 0)}%`
                : clientUpdate?.status === "installing"
                  ? "Restarting…"
                  : "Update desktop"
            : copied
              ? "Copied"
              : status.updaterAvailable
                ? "Update server"
                : "Copy update command"}
        </button>
      )}
    </div>
  );
}
