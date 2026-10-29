import type { BusyBotsView } from "@openteam/contracts";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { CircleCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
import { API_BASE } from "../../../client/http";
import { useServerUpdate } from "../../../hooks/use-server-update";
import { cn } from "../../../lib/cn";
import { inSidebarOrder, useSidebarBotOrder } from "../../../lib/sidebar-bot-order";
import { SectionLabel, SettingsGroup } from "./ui";

const BUSY = "An agent is working. Update will be available when every agent is done.";
const BUSY_REFUSAL = "An agent could not pause. Nothing changed; try again when it settles.";
const FAILED = "The computer update failed. Try again.";
const BUSY_POLL_MS = 2_000;
const CONFIRM_RESET_MS = 3_000;

const button =
  "inline-flex h-8 items-center rounded-[8px] bg-black/[0.08] px-3 text-[12px] text-foreground transition-colors disabled:opacity-50 dark:bg-white/[0.09]";

/** A button that asks for a second click within 3 s before it acts, as the reference's settings do. */
export function ConfirmButton({
  label,
  pendingLabel,
  pending = false,
  disabled = false,
  onConfirm,
}: {
  label: string;
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const reset = window.setTimeout(() => setArmed(false), CONFIRM_RESET_MS);
    return () => window.clearTimeout(reset);
  }, [armed]);
  const confirming = armed && !pending && !disabled;
  return (
    <button
      aria-label={confirming ? `Click Again to Confirm: ${label}` : label}
      className={cn(
        button,
        confirming && "bg-red-500/15 text-red-600 dark:bg-red-500/20 dark:text-red-400"
      )}
      data-confirming={confirming || undefined}
      disabled={pending || disabled}
      onClick={() => {
        if (pending || disabled) return;
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
      type="button"
    >
      {pending && pendingLabel ? pendingLabel : confirming ? "Click Again to Confirm" : label}
    </button>
  );
}

/** Updates the server, worker and computer together, once no bot is working. */
export function ComputerUpdateSettings() {
  const {
    server,
    serverNeedsUpdate,
    serverUpdating,
    updateServer,
  } = useServerUpdate();
  const sidebarOrder = useSidebarBotOrder();
  const [busyBots, setBusyBots] = useState<BusyBotsView["bots"]>([]);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshBusy = useCallback(async () => {
    const next = await api.busyBots().catch(() => null);
    if (next) setBusyBots(next.bots);
    return next?.bots ?? [];
  }, []);

  const pending = serverNeedsUpdate && !serverUpdating;
  useEffect(() => {
    if (!pending) return;
    void refreshBusy();
    const interval = window.setInterval(() => void refreshBusy(), BUSY_POLL_MS);
    return () => window.clearInterval(interval);
  }, [pending, refreshBusy]);

  const updating = starting || serverUpdating;
  const knownVersion = Boolean(server?.currentVersion);
  const state = !server
    ? "loading"
    : updating
      ? "updating"
      : !knownVersion || (serverNeedsUpdate && !server.updaterAvailable)
        ? "unavailable"
        : !serverNeedsUpdate && server.status !== "error"
          ? "up-to-date"
          : busyBots.length > 0
            ? "busy"
            : "ready";
  const stopTarget = state === "busy" ? inSidebarOrder(busyBots, sidebarOrder)[0] : undefined;

  const update = async () => {
    setError(null);
    setStarting(true);
    try {
      // The card can lag the server by a poll; never start over a turn that just began.
      if ((await refreshBusy()).length > 0) return;
      await updateServer();
    } catch (cause) {
      setError(clientErrorMessage(cause, FAILED));
    } finally {
      setStarting(false);
    }
  };

  const stop = async (botId: string) => {
    setStopping(true);
    try {
      await api.stopBot(botId).catch(() => undefined);
      await refreshBusy();
    } finally {
      setStopping(false);
    }
  };

  const failure = error ?? (server?.status === "error" ? server.message : null);
  const extraCopy =
    state === "busy" ? (
      BUSY
    ) : state === "updating" ? (
      server?.message
    ) : state === "unavailable" ? (
      server?.message
    ) : failure && state !== "up-to-date" ? (
      failure === BUSY_REFUSAL ? (
        BUSY_REFUSAL
      ) : (
        <>
          {FAILED}
          <span className="block text-foreground-tertiary">{failure}</span>
        </>
      )
    ) : null;

  const updateButton = (
    <ConfirmButton
      disabled={state !== "ready"}
      label="Update"
      onConfirm={() => void update()}
      pending={state === "updating"}
      pendingLabel="Updating…"
    />
  );

  return (
    <>
      <SectionLabel>Connected server</SectionLabel>
      <SettingsGroup>
        <div
          className="flex min-h-[52px] items-center gap-5 py-2.5"
          data-settings-anchor="server-update"
          data-update-state={state}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] leading-[17px] text-foreground">
              {new URL(API_BASE).host}
            </div>
            <div className="mt-px max-w-[440px] text-[12px] leading-4 text-foreground-secondary">
              Bots keep their files, installed software and browser sign-ins. Open browser tabs
              aren’t reopened.
            </div>
            {extraCopy ? (
              <div
                aria-live="polite"
                className="mt-px max-w-[440px] text-[12px] leading-4 text-foreground-secondary"
              >
                {extraCopy}
              </div>
            ) : null}
            {state === "up-to-date" ? (
              <div
                className="mt-2 flex items-center gap-1.5 text-[12px] text-foreground-secondary"
                role="status"
              >
                <CircleCheck aria-hidden className="size-3.5" />
                Your server is on the latest version
              </div>
            ) : null}
          </div>
          {state === "up-to-date" ? null : (
            <div className="flex shrink-0 items-center gap-2">
              {stopTarget ? (
                <ConfirmButton
                  key={stopTarget.botId}
                  label={`Stop ${stopTarget.name}`}
                  onConfirm={() => void stop(stopTarget.botId)}
                  pending={stopping}
                />
              ) : null}
              {updateButton}
            </div>
          )}
        </div>

      </SettingsGroup>
    </>
  );
}
