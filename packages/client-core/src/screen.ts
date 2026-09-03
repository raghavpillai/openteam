import type { ScreenStatusView } from "@openteam/contracts";
import {
  createSerialPoller,
  createSerializedTakeoverController,
  type SerializedTakeoverController,
} from "./async";

export const SCREEN_STATUS_POLL_MS = 4_000;
export const SCREEN_TAKEOVER_HEARTBEAT_MS = 20_000;
export const SCREEN_FRAME_REFRESH_MS = 5_000;

export const enableScreenForSession = (current: ReadonlySet<string>, botId: string) => {
  if (current.has(botId)) return current;
  const next = new Set(current);
  next.add(botId);
  return next;
};

export const shouldLoadScreenStatus = (enabled: boolean, inspectorActive: boolean): boolean =>
  enabled && inspectorActive;

export const shouldPollScreenStatus = (
  enabled: boolean,
  inspectorActive: boolean,
  state: ScreenStatusView["state"] | undefined
): boolean => enabled && inspectorActive && state !== "ready";

export const shouldRefreshScreenFrame = ({
  enabled,
  inspectorActive,
  documentVisible,
  viewerOpen,
  state,
}: {
  enabled: boolean;
  inspectorActive: boolean;
  documentVisible: boolean;
  viewerOpen: boolean;
  state: ScreenStatusView["state"] | undefined;
}): boolean => {
  // Full-screen clients use the same authenticated frame broker as previews, so opening
  // the viewer must not pause screenshot refreshes.
  void viewerOpen;
  return enabled && inspectorActive && documentVisible && state === "ready";
};

export interface ScreenSessionController {
  activate: () => void;
  confirmTakeover: (active: boolean) => void;
  deactivate: () => void;
  setTakeover: (active: boolean) => void;
  stop: () => void;
  wake: () => void;
}

export interface ScreenSessionControllerOptions<Result extends { humanTakeover: boolean }> {
  pollStatus: () => Promise<void>;
  requestTakeover: (active: boolean) => Promise<Result>;
  onTakeoverResult: (result: Result) => void;
  onTakeoverBusyChange?: (busy: boolean) => void;
  onError?: (cause: unknown) => void;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Shared polling, takeover serialization, heartbeat, and focus-release lifecycle. */
export const createScreenSessionController = <Result extends { humanTakeover: boolean }>({
  pollStatus,
  requestTakeover,
  onTakeoverResult,
  onTakeoverBusyChange,
  onError,
  pollIntervalMs = SCREEN_STATUS_POLL_MS,
  heartbeatMs = SCREEN_TAKEOVER_HEARTBEAT_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
}: ScreenSessionControllerOptions<Result>): ScreenSessionController => {
  let active = false;
  let stopped = false;
  let takeoverHeld = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  const poller = createSerialPoller({
    intervalMs: pollIntervalMs,
    task: pollStatus,
    schedule,
    cancel,
  });
  let takeover!: SerializedTakeoverController;

  const clearHeartbeat = () => {
    if (heartbeatTimer === null) return;
    cancel(heartbeatTimer);
    heartbeatTimer = null;
  };
  const scheduleHeartbeat = () => {
    clearHeartbeat();
    if (!active || stopped || !takeoverHeld) return;
    heartbeatTimer = schedule(() => {
      heartbeatTimer = null;
      if (!active || stopped || !takeoverHeld) return;
      takeover.setDesired(true);
      scheduleHeartbeat();
    }, heartbeatMs);
  };
  const confirmTakeover = (nextActive: boolean) => {
    takeoverHeld = active && nextActive;
    scheduleHeartbeat();
  };

  takeover = createSerializedTakeoverController({
    request: requestTakeover,
    onBusyChange: onTakeoverBusyChange,
    onError,
    onResult: (result) => {
      confirmTakeover(result.humanTakeover);
      onTakeoverResult(result);
    },
  });

  const deactivate = () => {
    active = false;
    takeoverHeld = false;
    clearHeartbeat();
    poller.stop();
    takeover.release();
  };

  return {
    activate: () => {
      if (stopped) return;
      active = true;
      takeover.resume();
      poller.start();
      scheduleHeartbeat();
    },
    confirmTakeover,
    deactivate,
    setTakeover: (nextActive) => {
      if (!active || stopped) return;
      if (!nextActive) confirmTakeover(false);
      takeover.setDesired(nextActive);
    },
    stop: () => {
      if (stopped) return;
      deactivate();
      stopped = true;
    },
    wake: () => {
      if (active && !stopped) poller.wake();
    },
  };
};
