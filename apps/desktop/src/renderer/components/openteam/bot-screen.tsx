import { isWindowVisible, WINDOW_VISIBILITY_EVENT } from "../../lib/window-visibility";
import {
  createHandoffReleaseController,
  createKeyedRequestCoordinator,
  createSerialPoller,
  SCREEN_FRAME_REFRESH_MS,
  SCREEN_STATUS_POLL_MS,
  SCREEN_TAKEOVER_HEARTBEAT_MS,
} from "@openteam/client-core";
import type { BotView, ScreenStatusView } from "@openteam/contracts";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { LoaderCircle, Minimize2, Monitor, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../../client/http";
import { api } from "../../client/openteam-api";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import { measureUntilNextPaint, recordPerformance } from "../../lib/performance";
import {
  shouldLoadScreenStatus,
  shouldPollScreenStatus,
  shouldRefreshScreenFrame,
} from "../../lib/screen-session";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import VncComputer from "./vnc-computer";

const statusRequests = createKeyedRequestCoordinator();

function loadScreenStatus(botId: string) {
  return statusRequests.run(botId, () => api.screenStatus(botId));
}

export function BotScreen({
  bot,
  active,
  enabled,
  handoff,
  onEnable,
  onHandoffFinished,
  onRetry,
}: {
  bot: BotView;
  active: boolean;
  enabled: boolean;
  handoff?: { botId: string; messageId: string } | null;
  onEnable: () => void;
  onHandoffFinished?: () => void;
  onRetry?: () => Promise<void>;
}) {
  const [screen, setScreen] = useState<ScreenStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const recordViewerReady = useCallback(() => {
    if (!viewerOpenedAt.current) return;
    recordPerformance("view.desktop-ready", performance.now() - viewerOpenedAt.current, { botId: bot.id });
    viewerOpenedAt.current = 0;
  }, [bot.id]);
  const [handoffPending, setHandoffPending] = useState(false);
  const viewerOpenedAt = useRef(0);
  const handoffMessageId = handoff?.messageId;
  const handoffRelease = useMemo(
    () =>
      createHandoffReleaseController({
        release: () => {
          if (handoffMessageId) api.releaseComputerHandoff(handoffMessageId);
        },
      }),
    [handoffMessageId]
  );
  const refreshStatus = useCallback(async () => {
    try {
      const next = await loadScreenStatus(bot.id);
      setScreen(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not load the shared computer"));
      return null;
    }
  }, [bot.id]);

  useEffect(() => {
    if (shouldLoadScreenStatus(enabled, active) && !screen) void refreshStatus();
  }, [active, enabled, refreshStatus, screen]);
  useEffect(() => {
    if (!shouldPollScreenStatus(enabled, active, screen?.state)) return;
    const poller = createSerialPoller({
      intervalMs: SCREEN_STATUS_POLL_MS,
      immediate: false,
      task: async () => {
        if (isWindowVisible()) await refreshStatus();
      },
    });
    const pollStatus = () => poller.wake();
    poller.start();
    window.addEventListener(WINDOW_VISIBILITY_EVENT, pollStatus);
    return () => {
      poller.stop();
      window.removeEventListener(WINDOW_VISIBILITY_EVENT, pollStatus);
    };
  }, [active, enabled, refreshStatus, screen?.state]);
  useEffect(() => {
    if (open) return;
    const refreshFrame = () => {
      if (
        shouldRefreshScreenFrame({
          enabled,
          inspectorActive: active,
          documentVisible: isWindowVisible(),
          viewerOpen: open,
          state: screen?.state,
        })
      ) {
        setFrameRevision(Date.now());
      }
    };
    refreshFrame();
    if (!enabled || !active || screen?.state !== "ready") return;
    const timer = window.setInterval(refreshFrame, SCREEN_FRAME_REFRESH_MS);
    window.addEventListener(WINDOW_VISIBILITY_EVENT, refreshFrame);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(WINDOW_VISIBILITY_EVENT, refreshFrame);
    };
  }, [active, enabled, open, screen?.state]);
  const finishHandoff = useCallback(
    async (action: "complete" | "skip" | "dismiss") => {
      if (!handoff || handoffPending || !handoffRelease.beginFinish()) return;
      setHandoffPending(true);
      try {
        await api.mutateComputerHandoff(handoff.messageId, action);
        setOpen(false);
        onHandoffFinished?.();
      } catch (cause) {
        handoffRelease.retry();
        setError(clientErrorMessage(cause, "Could not return computer control"));
      } finally {
        setHandoffPending(false);
      }
    },
    [handoff, handoffPending, handoffRelease, onHandoffFinished]
  );
  const closeViewer = useCallback(() => {
    if (handoff) {
      void finishHandoff("dismiss");
      return;
    }
    setOpen(false);
  }, [finishHandoff, handoff]);
  useEffect(() => {
    if (active || !open) return;
    closeViewer();
  }, [active, closeViewer, open]);
  useEffect(() => {
    if (!handoffMessageId) return;
    handoffRelease.resume();
    window.addEventListener("pagehide", handoffRelease.release);
    return () => {
      window.removeEventListener("pagehide", handoffRelease.release);
      handoffRelease.deferRelease();
    };
  }, [handoffMessageId, handoffRelease]);
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
    void refreshStatus();
  };
  useEffect(() => {
    if (!handoff || handoff.botId !== bot.id) return;
    onEnable();
    setOpen(true);
    if (!screen) void refreshStatus();
  }, [bot.id, handoff, onEnable, refreshStatus, screen]);
  useEffect(() => {
    if (!handoff || !open) return;
    let active = true;
    const poller = createSerialPoller({
      intervalMs: SCREEN_TAKEOVER_HEARTBEAT_MS,
      task: async () => {
        try {
          const next = await api.screenTakeover(bot.id, true);
          if (active) setScreen(next);
        } catch (cause) {
          if (active) setError(clientErrorMessage(cause, "Could not keep computer control"));
        }
      },
    });
    poller.start();
    window.addEventListener(WINDOW_VISIBILITY_EVENT, poller.wake);
    return () => {
      active = false;
      poller.stop();
      window.removeEventListener(WINDOW_VISIBILITY_EVENT, poller.wake);
    };
  }, [bot.id, handoff, open]);
  const viewerReady = screen?.state === "ready";
  const frameSource = useAuthenticatedResource(
    enabled && screen?.state === "ready" && !open ? api.screenFrameUrl(bot.id, frameRevision) : null,
    { retainPreviousFor: bot.id }
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
          aria-label="Open computer"
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
      {/* The inspector is transformed and clips overflow while animating. Keep
          the full-window computer outside that containing block. */}
      {open && createPortal(
        <div className="fixed inset-0 z-[70] flex flex-col bg-black/[0.94] text-white">
          <header className="electron-drag flex h-11 shrink-0 items-center justify-end gap-1 border-b border-white/[0.035] px-1">
            {handoff ? (
              <>
                <span className="mr-auto truncate px-3 text-sm text-white/70">
                  Complete the requested step
                </span>
                <Button
                  className="electron-no-drag text-white/70 hover:bg-white/[0.055] hover:text-white"
                  disabled={handoffPending}
                  onClick={() => void finishHandoff("skip")}
                  size="sm"
                  variant="ghost"
                >
                  Skip this step
                </Button>
                <Button
                  className="electron-no-drag bg-white text-black hover:bg-white/90"
                  disabled={handoffPending}
                  onClick={() => void finishHandoff("complete")}
                  size="sm"
                >
                  I'm done, continue
                </Button>
              </>
            ) : null}
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
                <VncComputer key={bot.id} botId={bot.id} name={bot.name}
                  serverUrl={API_BASE} createSession={api.screenVncSession}
                  onReady={recordViewerReady} onClose={closeViewer} />
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
        </div>,
        document.body
      )}
    </>
  );
}
