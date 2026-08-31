import type { BotView, ScreenStatusView } from "@openbot/contracts";
import { LoaderCircle, Minimize2, Monitor, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../client/openbot-api";
import { resolveViewerUrl } from "../../client/runtime-url";
import { measureUntilNextPaint, recordPerformance } from "../../lib/performance";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import {
  shouldLoadScreenStatus,
  shouldPollScreenStatus,
  shouldRefreshScreenFrame,
} from "../../lib/screen-session";
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
  enabled,
  onEnable,
  onRetry,
}: {
  bot: BotView;
  active: boolean;
  enabled: boolean;
  onEnable: () => void;
  onRetry?: () => Promise<void>;
}) {
  const [screen, setScreen] = useState<ScreenStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const takeoverRef = useRef(false);
  const viewerOpenedAt = useRef(0);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await loadScreenStatus(bot.id);
      setScreen(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [bot.id]);

  useEffect(() => {
    if (shouldLoadScreenStatus(enabled, active) && !screen) void refreshStatus();
  }, [active, enabled, refreshStatus, screen]);
  useEffect(() => {
    const refreshFrame = () => {
      if (
        shouldRefreshScreenFrame({
          enabled,
          inspectorActive: active,
          documentVisible: document.visibilityState === "visible",
          viewerOpen: open,
          state: screen?.state,
        })
      ) {
        setFrameRevision(Date.now());
      }
    };
    refreshFrame();
    if (!enabled || !active || open || screen?.state !== "ready") return;
    const timer = window.setInterval(refreshFrame, 5_000);
    document.addEventListener("visibilitychange", refreshFrame);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshFrame);
    };
  }, [active, enabled, open, screen?.state]);
  useEffect(() => {
    if (!shouldPollScreenStatus(enabled, active, screen?.state)) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    refreshWhenVisible();
    const timer = window.setInterval(refreshWhenVisible, 4_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [active, enabled, refreshStatus, screen?.state]);
  useEffect(() => {
    if (!open || screen?.state !== "ready" || screen.humanTakeover) return;
    let cancelled = false;
    void api
      .screenTakeover(bot.id, true)
      .then((next) => {
        if (cancelled) {
          if (next.humanTakeover) api.releaseScreenTakeover(bot.id);
          return;
        }
        takeoverRef.current = next.humanTakeover;
        setScreen(next);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, open, screen?.humanTakeover, screen?.state]);
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
    setScreen((current) =>
      current?.humanTakeover ? { ...current, humanTakeover: false } : current
    );
    if (takeoverRef.current) {
      takeoverRef.current = false;
      api.releaseScreenTakeover(bot.id);
    }
  }, [active, bot.id, open]);
  const closeViewer = useCallback(() => {
    setOpen(false);
    setScreen((current) =>
      current?.humanTakeover ? { ...current, humanTakeover: false } : current
    );
    if (!takeoverRef.current) return;
    takeoverRef.current = false;
    api.releaseScreenTakeover(bot.id);
  }, [bot.id]);
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeViewer();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeViewer, open]);

  const openViewer = () => {
    viewerOpenedAt.current = performance.now();
    measureUntilNextPaint("view.desktop-open", { botId: bot.id });
    onEnable();
    setOpen(true);
    if (!screen) void refreshStatus();
  };
  const viewerUrl = useMemo(() => {
    if (!screen?.viewerUrl) return "";
    const url = new URL(resolveViewerUrl(screen.viewerUrl, window.location.href));
    url.searchParams.set("view_only", "false");
    return url.toString();
  }, [screen]);
  const viewerReady = Boolean(screen?.state === "ready" && screen.humanTakeover && viewerUrl);
  const frameSource = useAuthenticatedResource(
    enabled && screen?.state === "ready" && !open ? api.screenFrameUrl(bot.id, frameRevision) : null
  );
  const retryConnection = () => {
    setError(null);
    setScreen(null);
    void refreshStatus();
  };

  return (
    <>
      <div className="mt-[3px] w-full overflow-hidden rounded-[7px] border border-[#d9d9d9] bg-[#f0f0f0] dark:border-[#323232] dark:bg-[#1b1b1b]">
        <Button
          aria-label={`Open ${bot.name}'s screen`}
          className="group relative block h-auto aspect-[16/10] w-full !cursor-pointer overflow-hidden rounded-none bg-[#f0f0f0] p-0 transition-colors duration-150 hover:bg-[#ededed] dark:bg-[#1b1b1b] dark:hover:bg-[#232323]"
          disabled={bot.status === "failed"}
          onClick={openViewer}
          type="button"
          variant="ghost"
        >
          {!enabled ? (
            <div className="grid size-full place-items-center bg-transparent text-[#757575] transition-colors duration-150 group-hover:text-[#626262] dark:text-[#8f8f8f] dark:group-hover:text-[#aaaaaa]">
              <Monitor className="size-4" strokeWidth={1.7} />
            </div>
          ) : screen?.state === "ready" && !open && frameSource ? (
            <img
              alt={`${bot.name}'s Linux screen`}
              className="size-full object-cover transition-opacity duration-150 group-hover:opacity-[0.97]"
              decoding="async"
              fetchPriority={active ? "high" : "low"}
              loading={active ? "eager" : "lazy"}
              onError={() => setError("Screen preview is reconnecting")}
              src={frameSource}
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
        </Button>
      </div>
      {(bot.status === "failed" || screen?.state === "failed") && onRetry && (
        <Button className="mt-2 w-full" onClick={() => void onRetry()} size="sm" variant="outline">
          <RefreshCw className="size-3.5" /> Retry setup
        </Button>
      )}
      {open && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-black/[0.94] text-white">
          <header className="electron-drag flex h-11 shrink-0 items-center justify-end border-b border-white/[0.035] px-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Close computer view"
                  className="electron-no-drag size-8 rounded-md text-white/65 hover:bg-white/[0.055] hover:text-white"
                  onClick={closeViewer}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Minimize2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close computer view</TooltipContent>
            </Tooltip>
          </header>
          <main
            className="flex min-h-0 flex-1 items-center justify-center p-2"
            onClick={(event) => event.target === event.currentTarget && closeViewer()}
            onKeyDown={(event) => event.key === "Escape" && closeViewer()}
          >
            <div
              className="relative aspect-[16/10] w-full overflow-hidden rounded-[6px] bg-[#1b1d1f]"
              style={{ maxWidth: "calc((100vh - 60px) * 1.6)" }}
            >
              {viewerReady ? (
                <iframe
                  className="absolute inset-0 size-full border-0 bg-[#1b1d1f]"
                  key={viewerUrl}
                  onLoad={() => {
                    if (!viewerOpenedAt.current) return;
                    recordPerformance(
                      "view.desktop-ready",
                      performance.now() - viewerOpenedAt.current,
                      { botId: bot.id }
                    );
                    viewerOpenedAt.current = 0;
                  }}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
                  src={viewerUrl}
                  title={`${bot.name}'s Linux computer`}
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center text-center">
                  <div>
                    <div className="flex items-center justify-center gap-2 text-[18px] font-medium">
                      {!error && <LoaderCircle className="size-4 animate-spin" />}
                      {error ??
                        (screen?.state === "failed"
                          ? "Computer setup needs attention"
                          : "Connecting…")}
                    </div>
                    {error && (
                      <Button
                        className="mt-4 border-white/15 bg-white/5 text-white hover:bg-white/10"
                        onClick={retryConnection}
                        size="sm"
                        variant="outline"
                      >
                        <RefreshCw className="size-3.5" /> Retry
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </main>
        </div>
      )}
    </>
  );
}
