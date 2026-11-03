import "./external-draft-card.css";
import "./imessage-send-card.css";
import type { ChannelMessageView } from "@openteam/contracts";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getDesktopMachineId } from "../../client/auth";
import { api } from "../../client/openteam-api";
import { LoadingOrb } from "../ui/loading-orb";
import { useMessagesIcon } from "./settings/messages-permissions-dialog";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.trim() ?? "";

function MessagesIcon({ size }: { size: number }) {
  const icon = useMessagesIcon();
  return icon ? (
    <img alt="" className="shrink-0" height={size} src={icon} width={size} />
  ) : (
    <MessageCircle aria-hidden className="shrink-0 text-[#34c759]" size={size} strokeWidth={2.25} />
  );
}

/** "Send this message?": a bot's text waits here until the user sends it from the named Mac. */
export function IMessageSendCard({ message }: { message: ChannelMessageView }) {
  const inFlight = useRef(false);
  const metadata = record(message.metadata);
  const send = record(metadata.imessage);
  const [state, setState] = useState(String(metadata.cardState ?? "pending"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setState(String(metadata.cardState ?? "pending")), [metadata.cardState]);
  const text = String(send.text ?? "");
  const name = typeof send.recipientName === "string" && send.recipientName ? send.recipientName : "";
  const handle = typeof send.to === "string" ? send.to : "";
  const recipient = String(send.recipientLabel ?? (name || handle));
  const local = typeof send.machineId === "string" && send.machineId === getDesktopMachineId();
  const where = local ? "your computer" : String(send.machineLabel ?? "your computer");
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
      setError(clientErrorMessage(failure, "Your answer didn't go through. Check your connection and try again."));
      // The server decides whether anything went out; never guess.
      const checked = await api.mutateIMessageSend(message.id, "refresh").catch(() => null);
      setState(checked ? String(record(checked.message.metadata).cardState ?? "pending") : "pending");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (state !== "pending" && state !== "sending") {
    const sent = state === "sent";
    const label = sent ? "Sent" : state === "dismissed" ? "Discarded" : state === "failed" ? "Not sent" : "Unconfirmed";
    const summary =
      state === "unknown"
        ? `The send was interrupted — check Messages on ${where} to see whether it went out`
        : `${sent ? "Sent to" : "To"} ${name || recipient} — “${firstLine(text)}”`;
    return (
      <section aria-label="Messages" className="draft-card rich-message-card imessage-card">
        <div className="draft-header">
          <span className="imessage-title">
            <MessagesIcon size={16} />
            Messages
          </span>
          <span className="draft-status" data-tone={sent ? "sent" : state === "failed" ? "warning" : "muted"} role="status">
            {state !== "unknown" && <span aria-hidden className="draft-status-dot" />}
            {label}
          </span>
        </div>
        <span className="draft-summary" title={summary}>{summary}</span>
        {sent && (metadata.allowedRecipient || metadata.sentUnder) ? (
          <p className="draft-note">
            {metadata.allowedRecipient ? `Later messages to ${name || recipient} from this computer won't ask` : `Sent without asking, as allowed on ${where}`}
          </p>
        ) : null}
        {state === "failed" && sendError ? <p className="draft-note" role="alert">{sendError}</p> : null}
      </section>
    );
  }
  const sending = state === "sending";
  return (
    <section
      aria-label="Send this message?"
      className="draft-card rich-message-card imessage-card"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy && !sending) void act("cancel");
      }}
    >
      <div className="imessage-title">
        <MessagesIcon size={20} />
        Send this message?
      </div>
      <div className="imessage-to">
        <span className="draft-label">To</span>
        {send.allowable === true || !send.chatId ? (
          <span>
            <span className="imessage-name">{name || handle}</span>
            {name && handle ? <span className="imessage-handle" dir="ltr">{handle}</span> : null}
          </span>
        ) : (
          <span className="imessage-name" dir="ltr">{recipient}</span>
        )}
      </div>
      <div className="imessage-bubble-row">
        <div className="imessage-bubble" dir="auto">{text}</div>
      </div>
      <p className="draft-note">The message will be sent from {where}</p>
      {(error || sendError) && <p className="draft-note" role="alert">{error || sendError}</p>}
      <div className="imessage-actions">
        <button className="draft-button draft-button-primary" data-sending={sending ? "" : undefined} disabled={busy || sending} onClick={() => void act("send")} type="button">
          {sending && <LoadingOrb aria-hidden size={14} />}
          {sending ? "Sending…" : "Send"}
        </button>
        {send.allowable === true && handle ? (
          <button className="draft-button draft-button-secondary" disabled={busy || sending} onClick={() => void act("allow")} type="button">
            Always allow {name || handle}
          </button>
        ) : null}
        <button className="draft-button draft-button-secondary" disabled={busy || sending} onClick={() => void act("cancel")} title="Discard (Esc)" type="button">
          Discard
        </button>
      </div>
    </section>
  );
}
