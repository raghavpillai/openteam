import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog";

function OpenTeamAppIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-16 rounded-[16px] shadow-[0_12px_24px_rgba(0,0,0,0.18)]"
      viewBox="0 0 70 70"
    >
      <defs>
        <linearGradient id="openteam-app-icon" x1="13" x2="58" y1="7" y2="66">
          <stop offset="0" stopColor="#f5f5f5" />
          <stop offset="0.5" stopColor="#d9d9d9" />
          <stop offset="1" stopColor="#a7a7a7" />
        </linearGradient>
      </defs>
      <rect fill="url(#openteam-app-icon)" height="70" rx="18" width="70" />
      <circle cx="35" cy="35" fill="#151515" r="19" />
      <circle cx="35" cy="35" fill="#f5f5f5" r="6" />
    </svg>
  );
}

export default function AboutPanel({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const version = window.openteam?.versions.app ?? "0.1.0";
  const copyVersion = () =>
    void navigator.clipboard?.writeText(
      `OpenTeam ${version}\nElectron ${window.openteam?.versions.electron ?? "unknown"}\nChrome ${window.openteam?.versions.chrome ?? "unknown"}`
    );
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-[272px] w-[360px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden rounded-[15px] border-black/10 bg-background p-0 shadow-[0_22px_70px_rgba(0,0,0,0.2)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">About OpenTeam</DialogTitle>
        <DialogDescription className="sr-only">
          OpenTeam version and copyright information.
        </DialogDescription>
        <DialogClose asChild>
          <button
            aria-label="Close About"
            className="absolute right-3.5 top-3.5 z-10 grid size-8 place-items-center rounded-full text-foreground-tertiary outline-none transition-colors hover:bg-black/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 dark:hover:bg-white/[0.06]"
            type="button"
          >
            <X className="size-4" strokeWidth={1.7} />
          </button>
        </DialogClose>
        <div className="flex h-full flex-col items-center pt-[34px] text-center">
          <OpenTeamAppIcon />
          <h2 className="mt-3 text-[20px] font-semibold leading-6 tracking-[-0.02em]">OpenTeam</h2>
          <div className="mt-0.5 text-[12px] leading-4 text-foreground-tertiary">
            Version {version}
          </div>
          <div className="mt-3 text-[12px] leading-4 text-foreground-tertiary">
            Copyright © 2026 OpenTeam contributors
          </div>
          <button
            className="mt-6 inline-flex h-8 items-center rounded-[8px] border border-black/[0.055] bg-black/[0.035] px-3 text-[12px] shadow-[0_1px_1px_rgba(0,0,0,0.02)] hover:bg-black/[0.06] dark:border-white/[0.07] dark:bg-white/[0.07] dark:hover:bg-white/[0.1]"
            onClick={copyVersion}
            type="button"
          >
            Copy version info
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
