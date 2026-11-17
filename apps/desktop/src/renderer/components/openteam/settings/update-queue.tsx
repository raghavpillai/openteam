import { Check, Download, LoaderCircle, Monitor, Server, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { API_BASE } from "../../../client/http";
import { useUpdateQueue } from "../../../hooks/use-update-queue";
import { Button } from "../../ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { settingsPrimaryButton, settingsSecondaryButton } from "./ui";

export function UpdateQueueSettings({
  targetVersion,
  clientVersion,
  serverVersion,
  available,
  disabled,
}: {
  targetVersion: string | null;
  clientVersion: string;
  serverVersion: string | null;
  available: boolean;
  disabled: boolean;
}) {
  const { state, start, retry } = useUpdateQueue();
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    if (!review) return;
    let active = true;
    const refresh = () =>
      void api
        .busyBots()
        .then((value) => {
          if (active) setBusy(value.bots.length);
        })
        .catch(() => {
          if (active) setBusy(null);
        });
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [review]);
  const running = state?.status === "running";
  return (
    <>
      {available && !running ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2">
          <p className="text-[12px] text-muted-foreground">
            Update separately, or update the server first and desktop last.
          </p>
          <Button
            className={settingsPrimaryButton}
            disabled={disabled}
            onClick={() => {
              setBusy(null);
              setReview(true);
            }}
            size="xs"
          >
            Update both…
          </Button>
        </div>
      ) : null}
      {state ? (
        <div
          className="mb-6 rounded-xl border p-3.5"
          data-update-queue={state.status}
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium">
              {state.status === "error"
                ? "Update queue paused"
                : running
                  ? "Updating OpenTeam"
                  : "Update queue finished"}
            </p>
            {state.status === "error" ? (
              <Button
                className={settingsSecondaryButton}
                disabled={disabled}
                size="xs"
                onClick={() => void retry()}
              >
                Retry queue
              </Button>
            ) : null}
          </div>
          <ol className="my-3 space-y-2 text-[12px]" aria-label="Update queue">
            <li className="flex items-center gap-2">
              {state.serverComplete ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : state.status === "error" ? (
                <TriangleAlert className="size-3.5 text-amber-600" />
              ) : (
                <LoaderCircle className="size-3.5 animate-spin" />
              )}
              <span className="flex-1">1. Connected server</span>
              <span className="text-muted-foreground">
                {state.serverComplete
                  ? "Updated"
                  : state.status === "error"
                    ? "Needs attention"
                    : "Updating…"}
              </span>
            </li>
            <li className="flex items-center gap-2">
              {state.status === "complete" ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : state.step === "desktop" && running ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Monitor className="size-3.5 text-muted-foreground" />
              )}
              <span className="flex-1">2. This desktop</span>
              <span className="text-muted-foreground">
                {state.status === "complete"
                  ? "Ready"
                  : state.step === "desktop"
                    ? state.status === "error"
                      ? "Needs attention"
                      : "Downloading…"
                    : "Queued"}
              </span>
            </li>
          </ol>
          <p
            className="text-[12px] leading-4 text-muted-foreground"
            role={state.status === "error" ? "alert" : "status"}
          >
            {state.message}
          </p>
        </div>
      ) : null}
      <AlertDialog open={review} onOpenChange={setReview}>
        <AlertDialogContent className="max-w-[520px] gap-5 p-5">
          <AlertDialogHeader>
            <AlertDialogTitle>Update server and desktop?</AlertDialogTitle>
            <AlertDialogDescription>
              OpenTeam {targetVersion}. The server updates first. This app restarts last, when
              you’re ready.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-left text-[12px]">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-normal">Update order</th>
                  <th className="px-3 py-2 font-normal">Version</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b">
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-2">
                      <Server className="size-3.5" />
                      Connected server
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {new URL(API_BASE).host}
                    </span>
                  </td>
                  <td className="px-3 py-3 tabular-nums">
                    {serverVersion} → {targetVersion}
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-2">
                      <Monitor className="size-3.5" />
                      This desktop
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      Restarts last
                    </span>
                  </td>
                  <td className="px-3 py-3 tabular-nums">
                    {clientVersion} → {targetVersion}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[12px] leading-5 text-muted-foreground">
            {busy === null
              ? "Checking for working bots…"
              : busy > 0
                ? `${busy} ${busy === 1 ? "bot is" : "bots are"} still working. Wait for every bot to finish before updating.`
                : "No bots are working. The server will briefly disconnect while it restarts. Your saved work stays in place."}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={busy !== 0 || disabled || !targetVersion}
              onClick={() => {
                setReview(false);
                if (targetVersion) void start(targetVersion);
              }}
            >
              <Download className="size-3.5" />
              Update both
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
