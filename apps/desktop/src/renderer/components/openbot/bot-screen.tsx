import {
  createKeyedRequestCoordinator,
  createScreenSessionController,
  SCREEN_FRAME_REFRESH_MS,
  type ScreenSessionController,
} from "@openbot/client-core";
import type { BotView, ScreenActionInput, ScreenStatusView } from "@openbot/contracts";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { LoaderCircle, Minimize2, Monitor, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../client/openbot-api";
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

const statusRequests = createKeyedRequestCoordinator();

function loadScreenStatus(botId: string) {
  return statusRequests.run(botId, () => api.screenStatus(botId));
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
  const screenSession = useRef<ScreenSessionController | null>(null);
  const viewerOpenedAt = useRef(0);
  const actionTail = useRef(Promise.resolve());
  const pointerGesture = useRef<{
    moved: boolean;
    path: Array<{ x: number; y: number }>;
    pointerId: number;
    start: { x: number; y: number };
  } | null>(null);
  const suppressNextClick = useRef(false);
  const screenRef = useRef(screen);
  const enabledRef = useRef(enabled);
  const activeRef = useRef(active);
  screenRef.current = screen;
  enabledRef.current = enabled;
  activeRef.current = active;

  const refreshStatus = useCallback(async () => {
    try {
      const next = await loadScreenStatus(bot.id);
      screenSession.current?.confirmTakeover(next.humanTakeover);
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
    if (!enabled || !active || screen?.state !== "ready") return;
    const timer = window.setInterval(refreshFrame, SCREEN_FRAME_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshFrame);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshFrame);
    };
  }, [active, enabled, open, screen?.state]);
  useEffect(() => {
    const controller = createScreenSessionController({
      pollStatus: async () => {
        if (
          document.visibilityState !== "visible" ||
          !shouldPollScreenStatus(enabledRef.current, activeRef.current, screenRef.current?.state)
        ) {
          return;
        }
        await refreshStatus();
      },
      requestTakeover: (active) => api.screenTakeover(bot.id, active),
      onError: (cause) => setError(clientErrorMessage(cause, "Could not change computer control")),
      onTakeoverResult: (next) => {
        takeoverRef.current = next.humanTakeover;
        setScreen(next);
        setError(null);
      },
    });
    screenSession.current = controller;
    return () => {
      controller.stop();
      if (screenSession.current === controller) screenSession.current = null;
      takeoverRef.current = false;
      api.releaseScreenTakeover(bot.id);
    };
  }, [bot.id, refreshStatus]);
  useEffect(() => {
    const controller = screenSession.current;
    if (!controller) return;
    const syncActivity = () => {
      if (shouldLoadScreenStatus(enabled, active)) controller.activate();
      else controller.deactivate();
    };
    const wakeWhenVisible = () => {
      if (document.visibilityState === "visible") controller.wake();
    };
    syncActivity();
    document.addEventListener("visibilitychange", wakeWhenVisible);
    return () => document.removeEventListener("visibilitychange", wakeWhenVisible);
  }, [active, bot.id, enabled]);
  useEffect(() => {
    if (!open || screen?.state !== "ready" || screen.humanTakeover) return;
    screenSession.current?.setTakeover(true);
  }, [open, screen?.humanTakeover, screen?.state]);
  useEffect(() => {
    takeoverRef.current = Boolean(screen?.humanTakeover);
    screenSession.current?.confirmTakeover(Boolean(screen?.humanTakeover));
  }, [screen?.humanTakeover]);
  useEffect(() => {
    const release = () => {
      screenSession.current?.deactivate();
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
    screenSession.current?.setTakeover(false);
    if (!takeoverRef.current) return;
    takeoverRef.current = false;
    api.releaseScreenTakeover(bot.id);
  }, [active, bot.id, open]);
  const closeViewer = useCallback(() => {
    setOpen(false);
    setScreen((current) =>
      current?.humanTakeover ? { ...current, humanTakeover: false } : current
    );
    screenSession.current?.setTakeover(false);
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
  const viewerReady = Boolean(screen?.state === "ready" && screen.humanTakeover);
  const frameSource = useAuthenticatedResource(
    enabled && screen?.state === "ready" ? api.screenFrameUrl(bot.id, frameRevision) : null
  );
  const act = useCallback(
    (input: ScreenActionInput) => {
      const request = actionTail.current
        .catch(() => undefined)
        .then(async () => {
          if (!takeoverRef.current) return;
          try {
            const next = await api.screenAction(bot.id, input);
            setScreen(next);
            setFrameRevision(Date.now());
            setError(null);
          } catch (cause) {
            setError(clientErrorMessage(cause, "The computer action failed"));
          }
        });
      actionTail.current = request;
      return request;
    },
    [bot.id]
  );
  const remotePoint = useCallback(
    (element: HTMLElement, clientX: number, clientY: number) => {
      const bounds = element.getBoundingClientRect();
      const width = screen?.width || 1280;
      const height = screen?.height || 800;
      return {
        x: Math.max(
          0,
          Math.min(width - 1, Math.round(((clientX - bounds.left) / bounds.width) * width))
        ),
        y: Math.max(
          0,
          Math.min(height - 1, Math.round(((clientY - bounds.top) / bounds.height) * height))
        ),
      };
    },
    [screen?.height, screen?.width]
  );
  const handleRemoteKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") return;
      const names: Record<string, string> = {
        Enter: "Return",
        Backspace: "BackSpace",
        Delete: "Delete",
        Tab: "Tab",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        ArrowUp: "Up",
        ArrowDown: "Down",
        Home: "Home",
        End: "End",
        PageUp: "Page_Up",
        PageDown: "Page_Down",
      };
      const key = names[event.key];
      const modifiers = [
        event.ctrlKey ? "Control" : "",
        event.altKey ? "Alt" : "",
        event.metaKey ? "Super" : "",
        event.shiftKey && (key || event.ctrlKey || event.altKey || event.metaKey) ? "Shift" : "",
      ].filter(Boolean);
      if (key || modifiers.length) {
        event.preventDefault();
        const finalKey = key || event.key.toLowerCase();
        void act({ action: "key", keys: [[...modifiers, finalKey].join("+")] });
      } else if (event.key.length === 1) {
        event.preventDefault();
        void act({ action: "type", text: event.key });
      }
    },
    [act]
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
              {viewerReady && frameSource ? (
                <div
                  aria-label={`${bot.name}'s interactive Linux computer`}
                  className="absolute inset-0 size-full cursor-crosshair bg-[#1b1d1f] outline-none"
                  onClick={(event) => {
                    if (suppressNextClick.current) {
                      suppressNextClick.current = false;
                      return;
                    }
                    event.currentTarget.focus();
                    void act({
                      action: "click",
                      ...remotePoint(event.currentTarget, event.clientX, event.clientY),
                      ...(event.detail > 1 ? { double: true } : {}),
                    });
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void act({
                      action: "click",
                      ...remotePoint(event.currentTarget, event.clientX, event.clientY),
                      button: "right",
                    });
                  }}
                  onKeyDown={handleRemoteKey}
                  onPointerCancel={(event) => {
                    if (pointerGesture.current?.pointerId === event.pointerId) {
                      pointerGesture.current = null;
                    }
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    const start = remotePoint(event.currentTarget, event.clientX, event.clientY);
                    pointerGesture.current = {
                      moved: false,
                      path: [start],
                      pointerId: event.pointerId,
                      start,
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const gesture = pointerGesture.current;
                    if (!gesture || gesture.pointerId !== event.pointerId || !(event.buttons & 1)) {
                      return;
                    }
                    const point = remotePoint(event.currentTarget, event.clientX, event.clientY);
                    if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= 4) {
                      gesture.moved = true;
                    }
                    const previous = gesture.path.at(-1);
                    if (
                      gesture.path.length < 100 &&
                      (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 4)
                    ) {
                      gesture.path.push(point);
                    }
                  }}
                  onPointerUp={(event) => {
                    const gesture = pointerGesture.current;
                    if (!gesture || gesture.pointerId !== event.pointerId) return;
                    pointerGesture.current = null;
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    if (!gesture.moved) return;
                    const end = remotePoint(event.currentTarget, event.clientX, event.clientY);
                    const previous = gesture.path.at(-1);
                    if (!previous || previous.x !== end.x || previous.y !== end.y) {
                      gesture.path.push(end);
                    }
                    suppressNextClick.current = true;
                    if (gesture.path.length >= 2) void act({ action: "drag", path: gesture.path });
                  }}
                  onWheel={(event) => {
                    event.preventDefault();
                    const deltaY = Math.max(-20, Math.min(20, Math.round(event.deltaY / 24)));
                    if (deltaY) void act({ action: "scroll", deltaY });
                  }}
                  role="application"
                  tabIndex={0}
                >
                  <img
                    alt={`${bot.name}'s Linux screen`}
                    className="pointer-events-none size-full select-none object-contain"
                    draggable={false}
                    key={frameSource}
                    onLoad={() => {
                      if (!viewerOpenedAt.current) return;
                      recordPerformance(
                        "view.desktop-ready",
                        performance.now() - viewerOpenedAt.current,
                        { botId: bot.id }
                      );
                      viewerOpenedAt.current = 0;
                    }}
                    src={frameSource}
                  />
                </div>
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
