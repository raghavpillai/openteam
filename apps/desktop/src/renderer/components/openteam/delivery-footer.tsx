import { ButtonPrimitive } from "../ui/button-primitive";
import { type CSSProperties, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DurableSendRecord } from "@openteam/product-core/durable-delivery";
import { sendRetryProgressVisible } from "../../lib/send-progress";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "../ui/dropdown-menu";

type DeliveryFooterProps = {
  delivery: DurableSendRecord | null;
  sendingSinceMs: number | null;
  onCancel: (nonce: string) => Promise<unknown>;
  onDelete: (nonce: string) => Promise<unknown>;
  onResend: (nonce: string) => Promise<unknown>;
};

// Keep the last caption mounted through its collapse, but allocate space only
// while it is visible. The virtualizer measures each frame of the transition.
export const DeliveryFooter = memo(function DeliveryFooter(props: DeliveryFooterProps) {
  const pending = props.delivery != null && props.delivery.phase !== "accepted-awaiting-echo";
  const expanded = props.delivery?.phase === "failed" || sendRetryProgressVisible(props.delivery);
  const queued = props.delivery?.phase === "queued";
  const [retained, setRetained] = useState(props.delivery);
  const clipRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const clip = clipRef.current!;
    const measure = () => setHeight(clip.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    return () => observer.disconnect();
  }, []);
  if (pending && retained !== props.delivery) setRetained(props.delivery);
  useEffect(() => {
    if (pending) return;
    // Reduced motion has no transitionend; this also covers interrupted transitions.
    const timer = setTimeout(() => setRetained(null),
      matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240);
    return () => clearTimeout(timer);
  }, [pending]);
  return (
    <div
      className="delivery-footer"
      data-delivery-footer=""
      style={{"--delivery-height": `${height}px`} as CSSProperties}
      data-expanded={expanded || undefined}
      data-queued={queued || undefined}
      aria-hidden={!pending || undefined}
      inert={!pending}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "height" && !pending)
          setRetained(null);
      }}
    >
      <div ref={clipRef} className="delivery-footer-clip">
        <DeliveryStatus {...props} delivery={pending ? props.delivery : retained} />
      </div>
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const act = (operation: () => Promise<unknown>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setActionError(null);
    void operation()
      .catch((cause) => {
        setActionError(clientErrorMessage(cause, "The message could not be updated. Try again."));
        setDetailsOpen(true);
      })
      .finally(() => {
        actionInFlight.current = false;
        setBusy(false);
      });
  };
  const actionClass =
    "rounded px-0.5 text-[11px] font-medium leading-4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 disabled:opacity-50";
  const details = delivery ? (
    <DropdownMenu open={detailsOpen} onOpenChange={setDetailsOpen}>
      <DropdownMenuTrigger asChild>
        <ButtonPrimitive className={actionClass} type="button" aria-label="Message delivery details">…</ButtonPrimitive>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        <p role={actionError ? "alert" : undefined} className="px-2 py-1.5 text-xs text-muted-foreground">
          {actionError ?? clientErrorMessage(delivery.failure?.message, "The message could not be sent.")}
        </p>
        <DropdownMenuItem disabled={busy} onSelect={() => act(() => onDelete(delivery.nonce))}>
          Delete message
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  if (delivery?.phase === "failed") {
    return (
      <div
        aria-label="Failed message actions"
        className="delivery-caption text-[11px] leading-4"
        data-failed-send-actions=""
        role="group"
      >
        <span className="font-medium text-destructive" role="status">
          {delivery.failure?.uncertain ? "Delivery unconfirmed" : "Not delivered"}
        </span>
        <ButtonPrimitive
          className={actionClass}
          disabled={busy}
          onClick={() => act(() => onResend(delivery.nonce))}
          type="button"
        >
          Retry
        </ButtonPrimitive>
        {details}
      </div>
    );
  }
  if (delivery && delivery.phase !== "accepted-awaiting-echo") {
    return (
      <div className={`delivery-caption delivery-caption-sending text-[11px] leading-4 text-muted-foreground${actionError ? " delivery-caption-sending-error" : ""}`}>
        {delivery.phase === "queued" ? (
          <ButtonPrimitive
            className={`delivery-queued-cancel ${actionClass}`}
            disabled={busy}
            onClick={() => act(() => onCancel(delivery.nonce))}
            type="button"
          >
            Cancel
          </ButtonPrimitive>
        ) : null}
        {sendRetryProgressVisible(delivery) ? (
          <span className="delivery-sending-bar" data-send-progress="" role="status" aria-label="Retrying message">
            <span />
          </span>
        ) : null}
        {actionError ? details : null}
      </div>
    );
  }
  return null;
}
