import { clientErrorMessage } from "@openteam/product-core/redaction";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DESKTOP_UPDATE_RESTART_EVENT } from "../../lib/desktop-update";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export function DesktopUpdateDialog() {
  const [update, setUpdate] = useState<OpenTeamUpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notifiedVersion = useRef<string | null>(null);
  const installingRef = useRef(false);

  useEffect(() => {
    let active = true;
    let receivedProgress = false;
    const receive = (next: OpenTeamUpdateStatus) => {
      if (!active) return;
      setUpdate(next);
      const version = next.latestVersion ?? "downloaded";
      if (next.status === "downloaded" && notifiedVersion.current !== version) {
        notifiedVersion.current = version;
        setError(null);
        setOpen(true);
      }
    };
    const request = (event: Event) => {
      const next = (event as CustomEvent<OpenTeamUpdateStatus>).detail;
      if (next.status !== "downloaded") return;
      receivedProgress = true;
      receive(next);
      setError(null);
      setOpen(true);
    };
    window.addEventListener(DESKTOP_UPDATE_RESTART_EVENT, request);
    const unsubscribe = window.openteam?.updates.onClientProgress((next) => {
      receivedProgress = true;
      receive(next);
    });
    void window.openteam?.updates
      .status()
      .then((next) => {
        if (!receivedProgress) receive(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe?.();
      window.removeEventListener(DESKTOP_UPDATE_RESTART_EVENT, request);
    };
  }, []);

  const install = async () => {
    if (!window.openteam || update?.status !== "downloaded" || installingRef.current) return;
    installingRef.current = true;
    setInstalling(true);
    setError(null);
    try {
      await window.openteam.updates.installClient();
    } catch (error) {
      installingRef.current = false;
      setInstalling(false);
      setError(clientErrorMessage(error, "Could not restart to update."));
      const current = await window.openteam.updates.status().catch(() => null);
      if (current) setUpdate(current);
    }
  };

  return (
    <AlertDialog onOpenChange={(next) => !installingRef.current && setOpen(next)} open={open}>
      {/* Insets and text offsets match the 2× reference. An inset shadow keeps
          the half-pixel outline from rounding up and changing the layout. */}
      <AlertDialogContent className="gap-6 border-0 pb-[12.5px] pl-[16.5px] pr-[12.5px] pt-[13.5px] antialiased shadow-[inset_0_0_0_0.5px_var(--border)] dark:shadow-[inset_0_0_0_0.5px_#3a3a3a]">
        <AlertDialogHeader className="gap-1">
          <AlertDialogTitle className="-translate-y-[1.5px] text-[14px] leading-[21px] tracking-[-0.125px]">
            Update ready
          </AlertDialogTitle>
          <AlertDialogDescription className="-translate-y-[0.5px] text-[14px] leading-[22px] tracking-[-0.12px]">
            Restart to finish installing OpenTeam
            {update?.latestVersion ? ` ${update.latestVersion}` : ""}. Your Bots and work will be
            right where you left them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className="text-[13px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter className="grid-cols-[minmax(0,132px)_minmax(0,1fr)] pt-0 max-[360px]:grid-cols-1">
          <AlertDialogCancel
            className="rounded-[9px] text-[14px] font-normal"
            disabled={installing}
          >
            <span className="-translate-y-[0.5px]">Not now</span>
          </AlertDialogCancel>
          <Button
            className="h-8 gap-1.5 rounded-[9px] bg-black text-[14px] font-normal text-white hover:bg-black/90 dark:bg-[#fafafa] dark:text-[#141414] dark:shadow-[inset_0_0_0_0.5px_#d7d7d7] dark:hover:bg-white/90"
            disabled={installing || update?.status !== "downloaded"}
            onClick={() => void install()}
          >
            {installing ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <svg
                aria-hidden="true"
                className="-translate-y-[0.5px] size-3.5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path d="M3.5 15v-2A4.5 4.5 0 0 1 8 8.5V7a4 4 0 0 1 8 0v1.5a4.5 4.5 0 0 1 4.5 4.5v2M12 10v11m-5-5 5 5 5-5" />
              </svg>
            )}
            <span className="-translate-y-[0.5px]">
              {installing ? "Restarting…" : "Restart to update"}
            </span>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
