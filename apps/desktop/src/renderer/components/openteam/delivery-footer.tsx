import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type DurableSendRecord,
  durableSendStatusLabel,
} from "@openteam/product-core/durable-delivery";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { formatOfflineDeliveryLabel } from "@openteam/product-core/timestamps";
import {
  subscribeDesktopSendTransport,
  desktopSendTransportSnapshot,
} from "../../lib/durable-sends";
import { sendProgressRevealDelay } from "../../lib/send-progress";

function SendProgress({ sinceMs }: { sinceMs: number }) {
  const [reveal, setReveal] = useState(() => {
    const mountedAtMs = Date.now();
    return { sinceMs, mountedAtMs, delayMs: sendProgressRevealDelay(sinceMs, mountedAtMs) };
  });
  if (reveal.sinceMs !== sinceMs) {
    setReveal({
      ...reveal,
      sinceMs,
      // Once visible, a change in the oldest pending attempt must not hide it again.
      delayMs:
        Date.now() >= reveal.mountedAtMs + reveal.delayMs
          ? reveal.delayMs
          : sendProgressRevealDelay(sinceMs, reveal.mountedAtMs),
    });
  }
  return (
    <div
      aria-hidden="true"
      className="send-progress"
      data-send-progress=""
      style={{ animationDelay: `${reveal.delayMs}ms` }}
    >
      <div className="send-progress-track">
        <div className="send-progress-segment" />
      </div>
    </div>
  );
}

export const DeliveryFooter = memo(function DeliveryFooter({
  delivery,
  sendingSinceMs,
  onCancel,
  onDelete,
  onResend,
}: {
  delivery: DurableSendRecord | null;
  sendingSinceMs: number | null;
  onCancel: (nonce: string) => Promise<unknown>;
  onDelete: (nonce: string) => Promise<unknown>;
  onResend: (nonce: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const transportDown = useSyncExternalStore(
    subscribeDesktopSendTransport,
    desktopSendTransportSnapshot,
    desktopSendTransportSnapshot
  );
  const currentOfflineAtMs = delivery?.queuedAtMs ?? null;
  const [retainedOfflineAtMs, setRetainedOfflineAtMs] = useState(currentOfflineAtMs);
  useEffect(() => {
    if (currentOfflineAtMs !== null) setRetainedOfflineAtMs(currentOfflineAtMs);
  }, [currentOfflineAtMs]);
  const act = (operation: () => Promise<unknown>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setActionError(null);
    void operation()
      .catch((cause) =>
        setActionError(clientErrorMessage(cause, "The message could not be updated. Try again."))
      )
      .finally(() => {
        actionInFlight.current = false;
        setBusy(false);
      });
  };
  const actionClass =
    "rounded px-0.5 text-[11px] font-medium leading-4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 disabled:opacity-50";
  if (delivery?.phase === "failed") {
    return (
      <div
        aria-label="Failed message actions"
        className="mt-1 flex flex-wrap items-center justify-end gap-1 self-end text-[11px] leading-4"
        data-failed-send-actions=""
        role="group"
      >
        <span className="font-medium text-destructive" role="status">
          {durableSendStatusLabel(delivery.phase)}
        </span>
        <button
          className={actionClass}
          disabled={busy}
          onClick={() => act(() => onResend(delivery.nonce))}
          type="button"
        >
          Resend
        </button>
        <button
          className={actionClass}
          disabled={busy}
          onClick={() => act(() => onDelete(delivery.nonce))}
          type="button"
        >
          Delete
        </button>
        {actionError || delivery.failure?.message ? (
          <span role="alert" className="w-full text-right text-destructive">
            {actionError ??
              clientErrorMessage(delivery.failure?.message, "The message could not be sent.")}
          </span>
        ) : null}
      </div>
    );
  }
  const pending = delivery?.phase === "prepared" || delivery?.phase === "dispatching";
  if (delivery?.phase === "queued" || (pending && transportDown)) {
    return (
      <div
        className="mt-1 flex flex-wrap items-center justify-end gap-1 self-end text-[11px] leading-4 text-muted-foreground"
        data-queued-send-notice=""
        role="status"
      >
        <span>{durableSendStatusLabel("queued", transportDown)}</span>
        {delivery?.phase === "queued" && (
          <button
            className={actionClass}
            disabled={busy}
            onClick={() => act(() => onCancel(delivery.nonce))}
            type="button"
          >
            Cancel
          </button>
        )}
        {actionError ? (
          <span role="alert" className="w-full text-right text-destructive">
            {actionError}
          </span>
        ) : null}
      </div>
    );
  }
  const progress =
    pending && sendingSinceMs !== null && !transportDown ? (
      <SendProgress sinceMs={sendingSinceMs} />
    ) : null;
  const offlineAtMs = currentOfflineAtMs ?? retainedOfflineAtMs;
  if (
    offlineAtMs !== null &&
    (((pending || delivery?.phase === "accepted-awaiting-echo") && currentOfflineAtMs !== null) ||
      (delivery === null && retainedOfflineAtMs !== null))
  ) {
    const clearing = delivery === null;
    return (
      <>
        <div
          aria-hidden={clearing || undefined}
          className="sent-while-offline-notice self-end text-[11px] leading-4 text-muted-foreground"
          data-cleared={clearing || undefined}
          data-sent-while-offline=""
          role="status"
        >
          {formatOfflineDeliveryLabel(offlineAtMs)}
        </div>
        {progress}
      </>
    );
  }
  return progress;
});
