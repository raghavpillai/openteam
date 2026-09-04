import { openTeamCompatibility } from "@openteam/contracts/version-compatibility";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { ArrowRight, Check, Clipboard, LoaderCircle, TriangleAlert } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";
import { useServerUpdateStatus } from "../../hooks/use-server-update-status";
import { OPENTEAM_DEEP_LINK_EVENT } from "../../lib/app-deep-links";

const openUpdates = () =>
  window.dispatchEvent(
    new CustomEvent(OPENTEAM_DEEP_LINK_EVENT, {
      detail: { url: "grokbot://app/v1/settings?id=update-status" },
    })
  );

const COMPATIBILITY_TOAST_ID = "openteam-release-compatibility";

function PersistentCompatibilityToast({ children }: { children: ReactElement }) {
  useEffect(
    () => () => {
      toast.dismiss(COMPATIBILITY_TOAST_ID);
    },
    []
  );

  useEffect(() => {
    toast.custom(() => children, {
      id: COMPATIBILITY_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
      position: "bottom-right",
    });
  }, [children]);

  return null;
}

export function VersionMismatchBanner({ showReview = true }: { showReview?: boolean }) {
  const clientVersion = window.openteam?.versions.app ?? "0.0.1";
  const { status, loading, refresh } = useServerUpdateStatus(clientVersion);
  const [clientUpdate, setClientUpdate] = useState<OpenTeamUpdateStatus | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  if (loading || !status) return null;

  const compatibility = openTeamCompatibility(
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
  };

  const runDirectAction = async () => {
    if (acting) return;
    setActing(true);
    setActionError(null);
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
      ? "This server release cannot support your desktop app. Update the server to keep using OpenTeam."
      : compatibility === "client-update-required"
        ? "Your desktop app is outside the range supported by this server. Update the app to continue."
        : status.updaterAvailable
          ? "The server is not reporting enough release information. Update it first, then OpenTeam will check compatibility again."
          : "The server is not reporting enough release information. Copy and run the update command on the server computer.";

  const title =
    compatibility === "server-update-required"
      ? "Server update required"
      : compatibility === "client-update-required"
        ? "Desktop update required"
        : "Compatibility could not be verified";

  const clientUpdating = ["downloading", "installing"].includes(clientUpdate?.status ?? "");
  const actionLabel =
    compatibility === "client-update-required"
      ? clientUpdate?.status === "downloaded"
        ? "Restart to update"
        : clientUpdate?.status === "downloading"
          ? `Downloading ${Math.round(clientUpdate.progress ?? 0)}%`
          : clientUpdate?.status === "installing"
            ? "Restarting…"
            : "Update desktop"
      : copied
        ? "Command copied"
        : status.updaterAvailable
          ? "Update server"
          : "Copy update command";

  return (
    <PersistentCompatibilityToast>
      <div
        aria-atomic="true"
        aria-live="assertive"
        className="w-full rounded-2xl border border-amber-500/25 bg-background/95 text-foreground shadow-[0_18px_60px_rgba(0,0,0,0.22)] backdrop-blur-xl"
        role="alert"
      >
        <div className="flex items-start gap-3 p-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">
            <TriangleAlert className="size-[18px]" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-semibold leading-5">{title}</p>
              <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:text-amber-200">
                Action required
              </span>
            </div>

            <p className="mt-1 text-[12px] leading-[18px] text-muted-foreground">{message}</p>

            <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/80 bg-muted/55 px-3 py-2 text-[11px]">
              <span className="min-w-0">
                <span className="text-muted-foreground">Desktop</span>{" "}
                <span className="font-medium text-foreground">{clientVersion}</span>
              </span>
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="text-muted-foreground">Server</span>{" "}
                <span className="font-medium text-foreground">
                  {status.currentVersion ?? "Not reported"}
                </span>
              </span>
            </div>

            {actionError ? (
              <p className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] leading-4 text-destructive">
                {actionError}
              </p>
            ) : null}

            <div className="mt-3 flex items-center justify-end gap-2">
              {showReview ? (
                <button
                  className="h-8 rounded-lg px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
                  onClick={openUpdates}
                  type="button"
                >
                  View details
                </button>
              ) : null}
              <button
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-amber-950 px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-amber-500/35 disabled:pointer-events-none disabled:opacity-60 dark:bg-amber-100 dark:text-amber-950"
                disabled={acting || clientUpdating}
                onClick={() => void runDirectAction()}
                type="button"
              >
                {acting || clientUpdating ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : copied ? (
                  <Check className="size-3.5" />
                ) : compatibility !== "client-update-required" && !status.updaterAvailable ? (
                  <Clipboard className="size-3.5" />
                ) : null}
                {actionLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </PersistentCompatibilityToast>
  );
}
