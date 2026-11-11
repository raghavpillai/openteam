import { isWindowVisible, WINDOW_VISIBILITY_EVENT } from "../../lib/window-visibility";
import {
  createHandoffReleaseController,
  createKeyedRequestCoordinator,
  createSerialPoller,
  SCREEN_FRAME_REFRESH_MS,
  SCREEN_STATUS_POLL_MS,
  createComputerControlController,
  ownsComputerControl,
} from "@openteam/client-core";
import type { BotView, ScreenStatusView } from "@openteam/contracts";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { Eye, LoaderCircle, Minimize2, Monitor, SquareMousePointer, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../../client/http";
import { api } from "../../client/openteam-api";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import { useWindowVisible } from "../../hooks/use-window-active";
import { useResourceActive } from "../../hooks/resource-activity";
import { measureUntilNextPaint, recordPerformance } from "../../lib/performance";
import {
  shouldLoadScreenStatus,
  shouldPollScreenStatus,
  shouldRefreshScreenFrame,
} from "../../lib/screen-session";
import { Button } from "../ui/button";
import { ComputerConnectionStatus } from "./computer-connection-status";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import VncComputer from "./vnc-computer";
import { BotAvatar } from "./avatar";

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
  presentation = "preview",
}: {
  bot: BotView;
  active: boolean;
  enabled: boolean;
  handoff?: { botId: string; messageId: string; reason?: string } | null;
  onEnable: () => void;
  onHandoffFinished?: () => void;
  onRetry?: () => Promise<void>;
  presentation?: "preview" | "card";
}) {
  const visible = useWindowVisible();
  const resourcesActive = useResourceActive();
  const controlId = useMemo(() => {
    const key = `openteam:computer-control:${API_BASE}:${bot.id}`;
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  }, [bot.id]);
  const control = useMemo(
    () =>
      createComputerControlController(controlId, (active, input) =>
        api.screenTakeover(bot.id, active, false, input)
      ),
    [bot.id, controlId]
  );
  const controlRevision = useRef(0);
  const [screen, setScreen] = useState<ScreenStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const recordViewerReady = useCallback(() => {
    if (!viewerOpenedAt.current) return;
    recordPerformance("view.desktop-ready", performance.now() - viewerOpenedAt.current, {
      botId: bot.id,
    });
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
    const revision = controlRevision.current;
    try {
      const next = await loadScreenStatus(bot.id);
      if (revision !== controlRevision.current) return next;
      control.observe(next);
      setScreen(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not load the shared computer"));
      return null;
    }
  }, [bot.id, control]);

  useEffect(() => {
    if (visible && shouldLoadScreenStatus(enabled, active) && !screen) void refreshStatus();
  }, [active, enabled, refreshStatus, screen, visible]);
  useEffect(() => {
    if (!visible || !shouldPollScreenStatus(enabled, active, screen?.state)) return;
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
  }, [active, enabled, refreshStatus, screen?.state, visible]);
  useEffect(() => {
    if (open || !visible) return;
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
  }, [active, enabled, open, screen?.state, visible]);
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
    // The server took control when the card started; a cached status may predate that.
    void refreshStatus();
  }, [bot.id, handoff, onEnable, refreshStatus]);
  const controlling = ownsComputerControl(screen, controlId);
  const [controlPending, setControlPending] = useState(false);
  const [viewerConnected, setViewerConnected] = useState(false);
  const [watchHint, setWatchHint] = useState(false);
  useEffect(() => {
    setWatchHint(false);
  }, [open, controlling]);
  const changeControl = useCallback(
    async (active: boolean) => {
      if (controlPending) return;
      controlRevision.current += 1;
      setControlPending(true);
      try {
        const next = active ? await control.take(true) : await control.giveBack();
        if (next) setScreen(next);
        setError(null);
      } catch (cause) {
        setError(
          clientErrorMessage(
            cause,
            active ? "Could not take computer control" : "Could not give back control"
          )
        );
      } finally {
        controlRevision.current += 1;
        setControlPending(false);
      }
    },
    [control, controlPending]
  );
  const resumeBot = async () => {
    controlRevision.current += 1;
    setControlPending(true);
    try {
      const next = await api.screenTakeover(bot.id, false, false, { force: true });
      control.observe(next);
      setScreen(next);
    } catch (cause) {
      setError(clientErrorMessage(cause, "Could not resume the bot"));
    } finally {
      controlRevision.current += 1;
      setControlPending(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    control.open();
    const poller = createSerialPoller({
      intervalMs: SCREEN_STATUS_POLL_MS,
      immediate: true,
      task: async () => {
        if (isWindowVisible()) await refreshStatus();
      },
    });
    poller.start();
    window.addEventListener(WINDOW_VISIBILITY_EVENT, poller.wake);
    return () => {
      poller.stop();
      window.removeEventListener(WINDOW_VISIBILITY_EVENT, poller.wake);
      if (!handoff)
        void control.close().catch(() => {
          /* Ownership is reserved for reconnection. */
        });
    };
  }, [control, handoff, open, refreshStatus]);
  useEffect(() => {
    if (open && handoff && screen?.controlSession?.id === `handoff:${handoff.messageId}`)
      void changeControl(true);
  }, [open, handoff, screen?.controlSession?.id, changeControl]);
  const controlLabel =
    controlPending || screen?.controlPending
      ? "Changing control…"
      : controlling
        ? viewerConnected
          ? "You’re in control"
          : "Reconnecting — your control is reserved"
        : screen?.humanTakeover
          ? "Controlled on another device"
          : "Watching";
  const viewerReady = screen?.state === "ready";
  const frameSource = useAuthenticatedResource(
    enabled && active && screen?.state === "ready" && !open
      ? api.screenFrameUrl(bot.id, frameRevision)
      : null,
    { enabled: resourcesActive, retainPreviousFor: bot.id }
  );
  const retryConnection = () => {
    setError(null);
    setScreen(null);
    void refreshStatus();
  };
  const statusLabel = error
    ? "Unavailable"
    : bot.status === "failed" || screen?.state === "failed"
      ? "Needs attention"
      : bot.status === "provisioning" || screen?.state === "starting"
        ? "Starting…"
        : screen?.state === "ready"
          ? "Ready"
          : enabled
            ? "Connecting…"
            : "Not connected";

  return (
    <>
      {presentation === "card" ? (
        <button
          aria-label="Open computer"
          className="bot-computer-card"
          onClick={openViewer}
          type="button"
        >
          <span>
            Bot's computer
            <span className="bot-computer-status" role="status">
              {statusLabel}
            </span>
          </span>
          <span aria-hidden="true" className="bot-computer-preview">
            {frameSource && screen?.state === "ready" ? (
              <img
                alt=""
                decoding="async"
                onError={() => setError("Screen preview is reconnecting")}
                src={frameSource}
              />
            ) : (
              <span className="bot-computer-placeholder">
                <BotAvatar bot={bot} size="md" mode="still" />
                <span className="bot-computer-sleep">
                  z<span>z</span>
                </span>
              </span>
            )}
          </span>
        </button>
      ) : (
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
                <ComputerConnectionStatus
                  className="absolute inset-0 px-4 text-center text-[11px] text-white/60"
                  loading={!error && bot.status !== "failed" && screen?.state !== "failed"}
                >
                  {error ??
                    (bot.status === "failed" || screen?.state === "failed"
                      ? "Computer setup needs attention"
                      : `Starting ${bot.name}'s screen…`)}
                </ComputerConnectionStatus>
              </div>
            )}
          </Button>
        </div>
      )}
      {(bot.status === "failed" || screen?.state === "failed") && onRetry && (
        <Button className="mt-2 w-full" onClick={() => void onRetry()} size="sm" variant="outline">
          <RefreshCw className="size-3.5" /> Retry setup
        </Button>
      )}
      {/* The inspector is transformed and clips overflow while animating. Keep
          the full-window computer outside that containing block. */}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex flex-col bg-[#111111] text-white">
            {/* One draggable title row; content starts past the macOS window
              buttons, which end at x=76px. */}
            <header className="electron-drag flex min-h-11 shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 border-b border-white/[0.035] py-1.5 pl-[88px] pr-3">
              {handoff ? (
                <>
                  <span className="mr-auto min-w-0 basis-full py-2 text-[13px] leading-4 text-white/85 md:flex-1 md:basis-0 md:py-0">
                    {controlLabel + " · " + (handoff.reason || "Complete the requested step")}
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
            {error && viewerReady && (
              <p className="shrink-0 px-3 py-2 text-sm text-red-300" role="alert">
                {error}
              </p>
            )}
            <main
              className="flex min-h-0 flex-1 items-center justify-center px-5 py-2 [container-type:size]"
              onClick={(event) => event.target === event.currentTarget && closeViewer()}
              onKeyDown={(event) => event.key === "Escape" && closeViewer()}
            >
              {/* The largest 16:10 screen that fits the space below the header. */}
              <div
                className="relative aspect-[16/10] overflow-hidden rounded-lg bg-[#1b1d1f]"
                onPointerDownCapture={() => {
                  if (!controlling && viewerReady) setWatchHint(true);
                }}
                style={{ width: "min(100cqw, 160cqh)" }}
              >
                {viewerReady && visible ? (
                  <VncComputer
                    key={`${bot.id}:${controlling ? screen?.controlSession?.generation : 0}`}
                    botId={bot.id}
                    name={bot.name}
                    serverUrl={API_BASE}
                    createSession={(id, signal) =>
                      api.screenVncSession(id, signal, {
                        controlId,
                        ...(controlling ? { generation: screen?.controlSession?.generation } : {}),
                      })
                    }
                    clipboard={(input, signal) =>
                      api.screenClipboard(bot.id, input, signal, {
                        controlId,
                        generation: screen?.controlSession?.generation,
                      })
                    }
                    viewOnly={!controlling || controlPending}
                    onReady={recordViewerReady}
                    onConnectionChange={setViewerConnected}
                    onClose={closeViewer}
                  />
                ) : (
                  <div className="absolute inset-0 grid place-items-center text-center">
                    <div>
                      <ComputerConnectionStatus
                        loading={!error && screen?.state !== "failed"}
                        subtitle="Starting computer…"
                      >
                        {error ??
                          (screen?.state === "failed"
                            ? "Computer setup needs attention"
                            : "Connecting…")}
                      </ComputerConnectionStatus>
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
            <footer className="electron-no-drag flex shrink-0 justify-center px-4 pb-4 pt-2">
              <div
                aria-label="Computer control"
                role="group"
                className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-[28px] border border-white/[0.08] bg-[#242424]/90 py-1.5 pl-4 pr-1.5 text-[14px] shadow-[0_4px_24px_#0003] backdrop-blur-xl"
              >
                <span
                  aria-live="polite"
                  role="status"
                  className="flex min-w-0 items-center gap-2 text-white/70"
                >
                  {controlPending || screen?.controlPending ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-4 shrink-0 motion-safe:animate-spin"
                    />
                  ) : controlling ? (
                    <SquareMousePointer aria-hidden="true" className="size-4 shrink-0" />
                  ) : (
                    <Eye aria-hidden="true" className="size-4 shrink-0" />
                  )}
                  <span>
                    {controlLabel}
                    {watchHint && !controlling && !screen?.humanTakeover && (
                      <span className="ml-2 text-white/45">Take control to click and type</span>
                    )}
                  </span>
                </span>
                <button
                  aria-label={
                    controlling
                      ? "Give back control"
                      : screen?.humanTakeover
                        ? "Take control here"
                        : "Take control"
                  }
                  className={`min-h-9 shrink-0 rounded-full px-3.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#242424] disabled:cursor-wait disabled:opacity-45 ${controlling ? "bg-white/[0.07] text-white/85 hover:bg-white/[0.14]" : "bg-[#f7f7f7] text-[#202020] hover:bg-white"}`}
                  disabled={
                    controlPending || screen?.controlPending || (!controlling && !viewerReady)
                  }
                  onClick={() => void changeControl(!controlling)}
                  type="button"
                >
                  {controlling
                    ? "Stop"
                    : screen?.humanTakeover
                      ? "Take control here"
                      : "Take control"}
                </button>
                {!controlling && screen?.humanTakeover && (
                  <button
                    type="button"
                    className="min-h-9 rounded-full px-3 text-white/75 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-45"
                    disabled={controlPending || screen?.controlPending}
                    onClick={() => void resumeBot()}
                  >
                    Resume bot
                  </button>
                )}
              </div>
            </footer>
          </div>,
          document.body
        )}
    </>
  );
}
