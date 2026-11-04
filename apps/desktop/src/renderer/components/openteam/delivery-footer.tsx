import { memo, useRef, useState } from "react";
import {
  type DurableSendRecord,
  durableSendStatusLabel,
} from "@openteam/product-core/durable-delivery";
import { clientErrorMessage } from "@openteam/product-core/redaction";

type DeliveryFooterProps = {
  delivery: DurableSendRecord | null;
  sendingSinceMs: number | null;
  onCancel: (nonce: string) => Promise<unknown>;
  onDelete: (nonce: string) => Promise<unknown>;
  onResend: (nonce: string) => Promise<unknown>;
};

// Every outgoing row owns the same caption lane, including after reconciliation.
// Status changes can never resize the row and push a bottom-anchored bubble up.
export const DeliveryFooter = memo(function DeliveryFooter(props: DeliveryFooterProps) {
  return (
    <div className="delivery-footer" data-delivery-footer="">
      <DeliveryStatus {...props} />
    </div>
  );
});

function DeliveryStatus({
  delivery,
  onCancel,
  onDelete,
  onResend,
}: DeliveryFooterProps) {
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
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
        className="delivery-caption text-[11px] leading-4"
        data-failed-send-actions=""
        role="group"
      >
        <span className="font-medium text-destructive" role="status">
          {delivery.failure?.uncertain ? "Delivery unconfirmed" : durableSendStatusLabel(delivery.phase)}
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
          <span
            role="alert"
            className="w-full min-w-0 truncate text-right text-destructive"
            title={actionError ?? clientErrorMessage(delivery.failure?.message, "The message could not be sent.")}
          >
            {actionError ??
              clientErrorMessage(delivery.failure?.message, "The message could not be sent.")}
          </span>
        ) : null}
      </div>
    );
  }
  // Queued sends remain normal bubbles. Cancellation is an intentional hover
  // or keyboard action; routine queue/progress bookkeeping stays out of chat.
  if (delivery?.phase === "queued") {
    return (
      <div className="delivery-caption text-[11px] leading-4">
        <button
          className={`delivery-queued-cancel ${actionClass}`}
          disabled={busy}
          onClick={() => act(() => onCancel(delivery.nonce))}
          type="button"
        >
          Cancel
        </button>
        {actionError ? (
          <span role="alert" className="w-full min-w-0 truncate text-right text-destructive" title={actionError}>
            {actionError}
          </span>
        ) : null}
      </div>
    );
  }
  return null;
}
