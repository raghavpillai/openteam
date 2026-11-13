import { ButtonPrimitive } from "../../ui/button-primitive";
import { Button } from "../../ui/button";
import {
  BrainCircuit,
  CloudDownload,
  Globe,
  Keyboard,
  Mic,
  Monitor,
  Server,
  Settings,
  X,
} from "lucide-react";
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type SettingsAnchor,
  type SettingsView,
  settingsViewForAnchor,
} from "../../../lib/app-deep-links";
import { cn } from "../../../lib/cn";
import { SettingsGroup, SettingsHeading, SkeletonBar, SkeletonControl, SkeletonText } from "./ui";
import "./panel.css";
import { preloadable } from "./preloadable";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../ui/dialog";

const sections = {
  general: preloadable(() => import("./general")),
  computer: preloadable(() => import("./computer")),
  model: preloadable(() => import("./model")),
  voice: preloadable(() => import("./transcription")),
  keyboard: preloadable(() => import("./keyboard")),
  server: preloadable(() => import("./server")),
  providers: preloadable(() => import("./providers")),
  updates: preloadable(() => import("./updates")),
} satisfies Record<SettingsView, ReturnType<typeof preloadable>>;

const navigation: Array<{
  id: SettingsView;
  label: string;
  icon: typeof Settings;
  available: boolean;
}> = [
  { id: "general", label: "General", icon: Settings, available: true },
  { id: "computer", label: "Computer", icon: Monitor, available: true },
  { id: "model", label: "Model", icon: BrainCircuit, available: true },
  { id: "voice", label: "Voice notes", icon: Mic, available: true },
  { id: "keyboard", label: "Keyboard", icon: Keyboard, available: true },
  { id: "server", label: "Server", icon: Server, available: true },
  { id: "providers", label: "Providers", icon: Globe, available: true },
  { id: "updates", label: "Updates", icon: CloudDownload, available: true },
];

/** Stands in for a section while its code loads (sections are preloaded when Settings opens). */
function SectionSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading settings" role="status">
      {[3, 2].map((rows, group) => (
        <div key={group}>
          <div className="mb-2 mt-7 flex h-4 items-center px-2 first:mt-0">
            <SkeletonBar className="h-[8px] w-16" />
          </div>
          <SettingsGroup>
            {Array.from({ length: rows }, (_, row) => (
              <div
                className="flex min-h-[52px] items-center gap-5 border-t border-black/[0.065] py-2 first:border-t-0 dark:border-white/[0.07]"
                key={row}
              >
                <div className="min-w-0 flex-1 space-y-px">
                  <SkeletonText size="title" width={[132, 104, 156][row % 3]!} />
                  <SkeletonText width={[248, 196, 222][row % 3]!} />
                </div>
                <SkeletonControl width={[96, 34, 72][row % 3]!} />
              </div>
            ))}
          </SettingsGroup>
        </div>
      ))}
    </div>
  );
}

/** The selected item's highlight, which glides between sections instead of jumping. */
function useNavHighlight(view: SettingsView, open: boolean) {
  const navRef = useRef<HTMLElement>(null);
  const [box, setBox] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
    /** False for the first placement, which lands without gliding from the corner. */
    animate: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    // Closed: reopening places the pill afresh rather than gliding from the last section.
    if (!open || !nav) return setBox(null);
    const measure = () => {
      const item = nav.querySelector<HTMLElement>(`[data-settings-view="${view}"]`);
      if (!item) return;
      const next = {
        x: item.offsetLeft,
        y: item.offsetTop,
        w: item.offsetWidth,
        h: item.offsetHeight,
      };
      setBox((current) =>
        current &&
        current.x === next.x &&
        current.y === next.y &&
        current.w === next.w &&
        current.h === next.h
          ? current
          : { ...next, animate: current !== null }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [open, view]);
  return { navRef, box };
}

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
    void sections[nextView].preload();

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

  // Every section is a small chunk: fetch them all as Settings opens, so switching
  // sections renders at once instead of waiting on a network round-trip for code.
  useEffect(() => {
    if (!open) return;
    for (const section of Object.values(sections)) void section.preload();
  }, [open]);

  const { navRef, box } = useNavHighlight(view, open);
  const ActiveSection = sections[view].Component;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          const trigger = document.querySelector<HTMLElement>("[data-sidebar-account-trigger]");
          if (trigger) {
            event.preventDefault();
            trigger.focus();
          }
        }}
        className="grid h-[min(700px,calc(100vh-96px))] w-[min(900px,calc(100vw-40px))] max-w-none grid-cols-[198px_minmax(0,1fr)] gap-0 overflow-hidden rounded-[15px] border-black/10 bg-[#fcfcfc] p-0 shadow-[0_22px_70px_rgba(0,0,0,0.20)] dark:border-[#303030] dark:bg-[#070707] max-[512px]:grid-cols-1 max-[512px]:grid-rows-[auto_minmax(0,1fr)]"
        showCloseButton={false}
        surface="transparent"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure OpenTeam and application updates.
        </DialogDescription>
        <aside className="border-r-[0.5px] border-black/[0.07] bg-[#f7f7f7] px-3 pb-4 pt-4 dark:border-white/[0.07] dark:bg-[#111111] max-[512px]:border-b-[0.5px] max-[512px]:border-r-0 max-[512px]:py-2">
          <nav
            aria-label="Settings sections"
            className="relative space-y-0.5 max-[512px]:grid max-[512px]:grid-cols-2 max-[512px]:gap-1 max-[512px]:space-y-0"
            ref={navRef}
          >
            {box ? (
              <span
                aria-hidden="true"
                className="settings-nav-highlight"
                data-animate={box.animate || undefined}
                style={{
                  width: box.w,
                  height: box.h,
                  transform: `translate(${box.x}px, ${box.y}px)`,
                }}
              />
            ) : null}
            {navigation.map((item) => {
              const Icon = item.icon;
              const preload = () => void sections[item.id].preload();
              return (
                <ButtonPrimitive
                  aria-current={view === item.id ? "page" : undefined}
                  aria-disabled={!item.available}
                  className={cn(
                    "relative flex h-7 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] font-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/35 max-[512px]:justify-center",
                    view === item.id
                      ? box
                        ? ""
                        : "bg-selected"
                      : item.available
                        ? "hover:bg-hover"
                        : "cursor-default"
                  )}
                  data-settings-view={item.id}
                  key={item.id}
                  onClick={() => {
                    if (!item.available) return;
                    setView(item.id);
                    scrollRef.current?.scrollTo({ top: 0 });
                  }}
                  onFocus={preload}
                  onPointerEnter={preload}
                  type="button"
                >
                  <Icon className="size-[15px] shrink-0" strokeWidth={1.75} />
                  <span className="truncate">{item.label}</span>
                </ButtonPrimitive>
              );
            })}
          </nav>
        </aside>

        <section className="relative min-h-0 min-w-0">
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              className="absolute right-2.5 top-2.5 z-10 grid size-8 place-items-center rounded-full text-foreground-tertiary outline-none transition-colors hover:bg-black/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 dark:hover:bg-white/[0.06]"
              type="button"
            >
              <X className="size-4" strokeWidth={1.7} />
            </Button>
          </DialogClose>
          <div
            className="bot-scrollbar h-full overflow-y-auto px-8 pb-8 pt-8 max-[512px]:px-6"
            ref={scrollRef}
          >
            {/* Each section enters with a short fade and rise; keyed so a switch replays it. */}
            <div className="settings-view-enter" key={view}>
              {/* Providers renders its own heading, with a breadcrumb on its Search and Fetch pages. */}
              {view === "providers" ? null : (
                <SettingsHeading>
                  {navigation.find((item) => item.id === view)?.label ?? "General"}
                </SettingsHeading>
              )}
              <Suspense fallback={<SectionSkeleton />}>
                <ActiveSection />
              </Suspense>
            </div>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
