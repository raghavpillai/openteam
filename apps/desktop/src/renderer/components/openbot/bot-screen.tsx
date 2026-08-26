import type { BotView, ScreenStatusView } from "@openbot/contracts";
import {
  CircleAlert,
  FolderOpen,
  Globe2,
  Maximize2,
  Monitor,
  MousePointer2,
  Pause,
  Play,
  RefreshCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../client/openbot-api";
import { resolveViewerUrl } from "../../client/runtime-url";
import { measureUntilNextPaint, recordPerformance } from "../../lib/performance";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const statusRequests = new Map<string, Promise<ScreenStatusView>>();

function loadScreenStatus(botId: string) {
  const current = statusRequests.get(botId);
  if (current) return current;
  const request = api.screenStatus(botId).finally(() => statusRequests.delete(botId));
  statusRequests.set(botId, request);
  return request;
}

export function BotScreen({
  bot,
  active,
  onRetry,
}: {
  bot: BotView;
  active: boolean;
  onRetry?: () => Promise<void>;
}) {
  const [screen, setScreen] = useState<ScreenStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [busy, setBusy] = useState(false);
  const takeoverRef = useRef(false);
  const viewerOpenedAt = useRef(0);

  const refreshStatus = useCallback(async () => {
    try {
      setScreen(await loadScreenStatus(bot.id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [bot.id]);

  useEffect(() => {
    if (active && !screen) void refreshStatus();
  }, [active, refreshStatus, screen]);
  useEffect(() => {
    if (!active) return;
    const refreshFrame = () => {
      if (document.visibilityState === "visible") setFrameRevision(Date.now());
    };
    const timer = window.setInterval(refreshFrame, 5_000);
    document.addEventListener("visibilitychange", refreshFrame);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshFrame);
    };
  }, [active, open]);
  useEffect(() => {
    if (!active) return;
    if (screen?.state === "ready") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshStatus();
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [active, refreshStatus, screen?.state]);
  useEffect(() => {
    if (!open || !screen?.humanTakeover) return;
    const heartbeat = window.setInterval(() => {
      void api
        .screenTakeover(bot.id, true)
        .then(setScreen)
        .catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(heartbeat);
  }, [bot.id, open, screen?.humanTakeover]);
  useEffect(() => {
    takeoverRef.current = Boolean(screen?.humanTakeover);
  }, [screen?.humanTakeover]);
  useEffect(() => {
    const release = () => {
      if (!takeoverRef.current) return;
      takeoverRef.current = false;
      api.releaseScreenTakeover(bot.id);
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [bot.id]);
  useEffect(() => {
    if (active || !open) return;
    setOpen(false);
    setInteractive(false);
    if (takeoverRef.current) {
      takeoverRef.current = false;
      api.releaseScreenTakeover(bot.id);
    }
  }, [active, bot.id, open]);

  const withBusy = async (operation: () => Promise<ScreenStatusView>) => {
    setBusy(true);
    try {
      const next = await operation();
      setScreen(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const setTakeover = (active: boolean) => withBusy(() => api.screenTakeover(bot.id, active));
  const openViewer = async () => {
    viewerOpenedAt.current = performance.now();
    measureUntilNextPaint("view.desktop-open", { botId: bot.id });
    setInteractive(true);
    setOpen(true);
    if (!screen?.humanTakeover) {
      const next = await setTakeover(true);
      if (!next) setInteractive(false);
    }
  };
  const openApp = (app: "chromium" | "thunar" | "terminal") =>
    withBusy(() => api.screenAction(bot.id, { action: "open_app", app })).then(() =>
      setFrameRevision(Date.now())
    );
  const close = async () => {
    if (screen?.humanTakeover) await setTakeover(false);
    setInteractive(false);
    setOpen(false);
  };
  const viewerUrl = useMemo(() => {
    if (!screen?.viewerUrl) return "";
    const url = new URL(resolveViewerUrl(screen.viewerUrl, window.location.href));
    url.searchParams.set("view_only", interactive || screen.humanTakeover ? "false" : "true");
    return url.toString();
  }, [interactive, screen]);

  return (
    <>
      <div className="mt-[3px] w-full overflow-hidden rounded-[5px] bg-[#d6d6d6]">
        <Button
          className="group relative block h-auto aspect-[16/10] w-full overflow-hidden rounded-none p-0"
          disabled={!screen || screen.state !== "ready"}
          onClick={() => void openViewer()}
          type="button"
          variant="ghost"
        >
          {screen?.state === "ready" ? (
            <img
              alt={`${bot.name}'s Linux screen`}
              className="size-full object-cover"
              decoding="async"
              fetchPriority={active ? "high" : "low"}
              loading={active ? "eager" : "lazy"}
              onError={() => setError("Screen preview is reconnecting")}
              src={api.screenFrameUrl(bot.id, frameRevision)}
            />
          ) : (
            <div className="relative size-full">
              <Skeleton className="size-full rounded-none bg-neutral-800" />
              <span className="absolute inset-0 grid place-items-center px-4 text-center text-[11px] text-white/60">
                {error ??
                  (bot.status === "failed" || screen?.state === "failed"
                    ? "Computer setup needs attention"
                    : `Starting ${bot.name}'s screen…`)}
              </span>
            </div>
          )}
          <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/35 group-hover:opacity-100">
            <span className="flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1.5 text-xs text-white">
              <Maximize2 className="size-3.5" /> Open
            </span>
          </span>
        </Button>
      </div>
      {(bot.status === "failed" || screen?.state === "failed") && onRetry && (
        <Button className="mt-2 w-full" onClick={() => void onRetry()} size="sm" variant="outline">
          <RefreshCw className="size-3.5" /> Retry setup
        </Button>
      )}
      {open && screen && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-neutral-950 text-white">
          <header className="electron-drag flex h-14 shrink-0 items-center gap-2 border-b border-white/10 px-4">
            <Monitor className="size-4 text-blue-400" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {bot.name}'s computer
            </span>
            <div className="electron-no-drag flex items-center gap-1">
              {(
                [
                  ["chromium", Globe2, "Chromium"],
                  ["thunar", FolderOpen, "Thunar"],
                  ["terminal", TerminalSquare, "Terminal"],
                ] as const
              ).map(([app, Icon, label]) => (
                <Tooltip key={app}>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={label}
                      disabled={busy}
                      onClick={() => void openApp(app)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Icon className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              ))}
              <Button
                disabled={busy}
                onClick={() => void setTakeover(!screen.humanTakeover)}
                size="sm"
                variant={screen.humanTakeover ? "default" : "outline"}
              >
                <MousePointer2 className="size-3.5" />
                {screen.humanTakeover ? "Controlling" : "Take control"}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void withBusy(() => api.screenPause(bot.id, !screen.agentInputPaused))
                }
                size="sm"
                variant={screen.agentInputPaused ? "danger" : "ghost"}
              >
                {screen.agentInputPaused ? (
                  <Play className="size-3.5" />
                ) : (
                  <Pause className="size-3.5" />
                )}
                {screen.agentInputPaused ? "Resume agent" : "Pause agent"}
              </Button>
              <Button
                aria-label="Close computer"
                disabled={busy}
                onClick={() => void close()}
                size="icon-sm"
                variant="ghost"
              >
                <X className="size-4" />
              </Button>
            </div>
          </header>
          {error && (
            <div className="flex items-center gap-2 bg-red-500/15 px-4 py-2 text-xs text-red-200">
              <CircleAlert className="size-3.5" />
              <span className="flex-1">{error}</span>
              <Button onClick={() => void refreshStatus()} size="icon-sm" variant="ghost">
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
          )}
          <iframe
            className="min-h-0 flex-1 border-0 bg-neutral-900"
            key={viewerUrl}
            onLoad={() => {
              if (!viewerOpenedAt.current) return;
              recordPerformance("view.desktop-ready", performance.now() - viewerOpenedAt.current, {
                botId: bot.id,
              });
              viewerOpenedAt.current = 0;
            }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
            src={viewerUrl}
            title={`${bot.name}'s Linux computer`}
          />
          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-white/10 px-4 text-[10px] text-white/55">
            <span>
              {busy && !screen.humanTakeover
                ? "Acquiring input control…"
                : screen.humanTakeover
                  ? "Your input lease is active; agent GUI input is blocked."
                  : "View only; the agent may use this screen."}
            </span>
            <span>Browser session: computer-scoped · Filesystem: shared</span>
          </footer>
        </div>
      )}
    </>
  );
}
