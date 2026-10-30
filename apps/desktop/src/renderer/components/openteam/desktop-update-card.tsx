import { ArrowDownToLine, ArrowUpRight, Check, LoaderCircle, RotateCw } from "lucide-react";
import { cn } from "../../lib/cn";
import { desktopUpdateProgress } from "../../lib/desktop-update";

export function DesktopUpdateCard({
  update,
  startingDownload,
  onUpdate,
}: {
  update: OpenTeamUpdateStatus;
  startingDownload: boolean;
  onUpdate: () => void;
}) {
  const downloading = update.status === "downloading" || startingDownload;
  const ready = update.status === "downloaded";
  const installing = update.status === "installing";
  const progress = desktopUpdateProgress(update);
  const Icon = ready ? Check : installing ? RotateCw : ArrowDownToLine;

  return (
    <div
      className="mb-2 rounded-[11px] border border-blue-500/15 bg-gradient-to-br from-blue-500/[0.07] to-blue-500/[0.02] p-3 dark:border-blue-400/15 dark:from-blue-400/[0.12] dark:to-blue-400/[0.04]"
      data-desktop-update-card=""
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-white text-blue-600 shadow-xs ring-1 ring-blue-500/10 dark:bg-blue-400/10 dark:text-blue-300 dark:ring-blue-400/15">
          <Icon aria-hidden="true" className="size-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            aria-live="polite"
            className="text-[12.5px] font-medium leading-[18px] text-foreground"
          >
            {downloading
              ? "Downloading update"
              : ready
                ? "Ready to restart"
                : installing
                  ? "Restarting OpenTeam…"
                  : "Update available"}
          </p>
          <p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">
            {ready
              ? "Your work will be right here."
              : installing
                ? "Finishing up your update"
                : update.latestVersion
                  ? `OpenTeam ${update.latestVersion}`
                  : "A new version of OpenTeam"}
          </p>
        </div>
      </div>

      {downloading || installing ? (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] leading-4 text-muted-foreground">
            <span>{installing ? "See you in a moment" : "You can keep working"}</span>
            <span className="tabular-nums text-blue-600 dark:text-blue-300">
              {installing ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-3 animate-spin motion-reduce:animate-none"
                />
              ) : progress === null ? (
                "Preparing…"
              ) : (
                `${progress}%`
              )}
            </span>
          </div>
          <div
            aria-label={installing ? "Installing update" : "Downloading update"}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={installing ? undefined : (progress ?? undefined)}
            className="h-1 overflow-hidden rounded-full bg-blue-500/10 dark:bg-blue-300/10"
            role="progressbar"
          >
            <div
              className={cn(
                "h-full rounded-full bg-blue-500 transition-[width] duration-300 motion-reduce:transition-none dark:bg-blue-400",
                (installing || progress === null) && "animate-pulse motion-reduce:animate-none"
              )}
              style={{ width: installing ? "100%" : progress === null ? "35%" : `${progress}%` }}
            />
          </div>
        </div>
      ) : (
        <button
          className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-[7px] bg-blue-600 px-2 text-[12px] font-medium text-white shadow-xs transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-popover dark:bg-blue-500 dark:hover:bg-blue-400"
          onClick={onUpdate}
          type="button"
        >
          {ready ? <RotateCw aria-hidden="true" className="size-3.5" /> : null}
          {ready ? "Restart to update" : "Download update"}
          {!ready ? <ArrowUpRight aria-hidden="true" className="size-3.5" /> : null}
        </button>
      )}
    </div>
  );
}
