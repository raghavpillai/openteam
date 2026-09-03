import { CloudDownload, Monitor, Server, Settings, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  type SettingsAnchor,
  type SettingsView,
  settingsViewForAnchor,
} from "../../lib/app-deep-links";
import { cn } from "../../lib/cn";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

const loadGeneralSettings = () => import("./settings-general");
const loadComputerSettings = () => import("./settings-computer");
const loadServerSettings = () => import("./settings-server");
const loadUpdatesSettings = () => import("./settings-updates");

const GeneralSettings = lazy(loadGeneralSettings);
const ComputerSettings = lazy(loadComputerSettings);
const ServerSettings = lazy(loadServerSettings);
const UpdatesSettings = lazy(loadUpdatesSettings);

const sectionLoaders: Record<SettingsView, () => Promise<unknown>> = {
  general: loadGeneralSettings,
  computer: loadComputerSettings,
  server: loadServerSettings,
  updates: loadUpdatesSettings,
};

const sectionComponents = {
  general: GeneralSettings,
  computer: ComputerSettings,
  server: ServerSettings,
  updates: UpdatesSettings,
};

const navigation: Array<{
  id: SettingsView;
  label: string;
  icon: typeof Settings;
  available: boolean;
}> = [
  { id: "general", label: "General", icon: Settings, available: true },
  { id: "computer", label: "Computer", icon: Monitor, available: true },
  { id: "server", label: "Server", icon: Server, available: true },
  { id: "updates", label: "Updates", icon: CloudDownload, available: true },
];

export function SettingsPanel({
  onOpenChange,
  open,
  target,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  target?: { anchor: SettingsAnchor; nonce: number } | null;
}) {
  const [view, setView] = useState<SettingsView>("general");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && !target) setView("general");
  }, [open, target]);

  useEffect(() => {
    if (!open || !target) return;
    const nextView = settingsViewForAnchor(target.anchor);
    setView(nextView);
    void sectionLoaders[nextView]();

    let frame = 0;
    let highlightTimer = 0;
    let attempts = 0;
    const revealTarget = () => {
      const row = Array.from(
        scrollRef.current?.querySelectorAll<HTMLElement>("[data-settings-anchor]") ?? []
      ).find((candidate) => candidate.dataset.settingsAnchor?.split(" ").includes(target.anchor));
      if (!row) {
        attempts += 1;
        if (attempts < 120) frame = window.requestAnimationFrame(revealTarget);
        return;
      }
      row.scrollIntoView({ block: "center" });
      row.classList.remove("settings-anchor-target");
      frame = window.requestAnimationFrame(() => row.classList.add("settings-anchor-target"));
      highlightTimer = window.setTimeout(
        () => row.classList.remove("settings-anchor-target"),
        1_800
      );
    };
    frame = window.requestAnimationFrame(revealTarget);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(highlightTimer);
    };
  }, [open, target]);

  const ActiveSection = sectionComponents[view];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid h-[min(700px,calc(100vh-96px))] w-[min(1000px,calc(100vw-40px))] max-w-none grid-cols-[198px_minmax(0,1fr)] gap-0 overflow-hidden rounded-[15px] border-black/10 bg-[#fcfcfc] p-0 shadow-[0_22px_70px_rgba(0,0,0,0.20)] dark:border-[#303030] dark:bg-[#070707] max-sm:grid-cols-1 max-sm:grid-rows-[auto_minmax(0,1fr)]"
        showCloseButton={false}
        surface="transparent"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure OpenBot and application updates.
        </DialogDescription>
        <aside className="border-r-[0.5px] border-black/[0.07] bg-[#f7f7f7] px-3 pb-4 pt-4 dark:border-white/[0.07] dark:bg-[#111111] max-sm:border-b-[0.5px] max-sm:border-r-0 max-sm:py-2">
          <nav
            aria-label="Settings sections"
            className="space-y-0.5 max-sm:flex max-sm:gap-1 max-sm:space-y-0"
          >
            {navigation.map((item) => {
              const Icon = item.icon;
              const preload = () => void sectionLoaders[item.id]();
              return (
                <button
                  aria-current={view === item.id ? "page" : undefined}
                  aria-disabled={!item.available}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] font-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/35 max-sm:justify-center",
                    view === item.id
                      ? "bg-black/[0.1] dark:bg-white/[0.1]"
                      : item.available
                        ? "hover:bg-black/[0.045] dark:hover:bg-white/[0.06]"
                        : "cursor-default"
                  )}
                  key={item.id}
                  onClick={() => item.available && setView(item.id)}
                  onFocus={preload}
                  onPointerEnter={preload}
                  type="button"
                >
                  <Icon className="size-[15px] shrink-0" strokeWidth={1.75} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <section className="relative min-w-0">
          <DialogClose asChild>
            <button
              aria-label="Close"
              className="absolute right-2.5 top-2.5 z-10 grid size-8 place-items-center rounded-full text-foreground-tertiary outline-none transition-colors hover:bg-black/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 dark:hover:bg-white/[0.06]"
              type="button"
            >
              <X className="size-4" strokeWidth={1.7} />
            </button>
          </DialogClose>
          <div
            className="grok-scrollbar h-full overflow-y-auto px-8 pb-8 pt-8 max-sm:px-6"
            ref={scrollRef}
          >
            <h2 className="mb-7 px-2 text-[17px] font-medium leading-6 tracking-[-0.018em]">
              {view === "updates"
                ? "Updates"
                : view === "computer"
                  ? "Computer"
                  : view === "server"
                    ? "Server"
                    : "General"}
            </h2>
            <Suspense fallback={null}>
              <ActiveSection />
            </Suspense>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
