import "./external-draft-card.css";
import type { ChannelMessageView } from "@openteam/contracts";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useEffect, useRef, useState } from "react";
import { api } from "../../client/openteam-api";
import { LoadingOrb } from "../ui/loading-orb";
import { Field } from "./external-draft-card";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Ready to send", tone: "ready" },
  sending: { label: "Sending…", tone: "ready" },
  sent: { label: "Sent", tone: "sent" },
  dismissed: { label: "Discarded", tone: "muted" },
  unknown: { label: "Unconfirmed", tone: "muted" },
  failed: { label: "Message not delivered", tone: "warning" },
};

/** "Send this message?": a bot's text waits here until the user sends it from the named Mac. */
export function IMessageSendCard({ message }: { message: ChannelMessageView }) {
  const inFlight = useRef(false);
  const metadata = record(message.metadata);
  const send = record(metadata.imessage);
  const [state, setState] = useState(String(metadata.cardState ?? "pending"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setState(String(metadata.cardState ?? "pending")), [metadata.cardState]);
  const recipient = String(send.recipientLabel ?? send.to ?? "");
  const handle = send.to && send.recipientName ? String(send.to) : "";
  const machine = String(send.machineLabel ?? "your Mac");
  const sendError = typeof metadata.sendError === "string" ? metadata.sendError : "";
  const act = async (action: "send" | "allow" | "cancel") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (action !== "cancel") setState("sending");
      const result = await api.mutateIMessageSend(message.id, action);
      const next = record(result.message.metadata);
      setState(String(next.cardState ?? "pending"));
      if (next.cardState === "pending" && typeof next.sendError === "string") setError(next.sendError);
    } catch (failure) {
      setError(clientErrorMessage(failure, action === "cancel" ? "Couldn't discard this text. Try again." : "Couldn't send this text"));
      // The server decides whether anything went out; never guess.
      const checked = await api.mutateIMessageSend(message.id, "refresh").catch(() => null);
      if (checked) setState(String(record(checked.message.metadata).cardState ?? "pending"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const status = STATUS[state] ?? STATUS.unknown!;
  const header = (
    <div className="draft-header">
      <span className="draft-title">Send this message?</span>
      <span className="draft-status" data-tone={status.tone} role="status">
        <span aria-hidden className="draft-status-dot" />
        {status.label}
      </span>
    </div>
  );
  if (state !== "pending" && state !== "sending") {
    const summary =
      state === "unknown"
        ? `The send was interrupted — check Messages on ${machine} to see whether it went out`
        : `${state === "sent" ? "Sent to" : "To"} ${recipient} — “${String(send.text ?? "")}”`;
    return (
      <section aria-label="Send this message?" className="draft-card rich-message-card">
        {header}
        <span className="draft-summary" title={summary}>{summary}</span>
        {metadata.sentUnder ? <p className="draft-note">Sent without asking, as allowed on {machine}</p> : null}
        {state === "failed" && sendError ? <p className="draft-note" role="alert">{sendError}</p> : null}
      </section>
    );
  }
  const sending = state === "sending";
  return (
    <section aria-label="Send this message?" className="draft-card rich-message-card">
      {header}
      <div className="draft-panel">
        <div className="draft-fields">
          <Field label="From">{machine}</Field>
          <Field label="To">{handle ? `${recipient} (${handle})` : recipient}</Field>
        </div>
        <div className="draft-body" dir="auto" style={{ whiteSpace: "pre-wrap" }}>{String(send.text ?? "")}</div>
      </div>
      <p className="draft-note">The message will be sent from {machine}</p>
      {(error || sendError) && <p className="draft-note" role="alert">{error || sendError}</p>}
      <div className="draft-footer">
        <div className="draft-actions">
          <button className="draft-button draft-button-primary" data-sending={sending ? "" : undefined} disabled={busy || sending} onClick={() => void act("send")} type="button">
            {sending && <LoadingOrb aria-hidden size={14} />}
            {sending ? "Sending…" : "Send"}
          </button>
          <button className="draft-button draft-button-secondary" disabled={busy || sending} onClick={() => void act("cancel")} type="button">
            Discard
          </button>
        </div>
        {send.allowable === true && send.to ? (
          <button className="draft-trigger" disabled={busy || sending} onClick={() => void act("allow")} type="button">
            Always allow {recipient}
          </button>
        ) : null}
      </div>
    </section>
  );
}
