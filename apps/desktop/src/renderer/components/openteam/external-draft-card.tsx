import type { ChannelMessageView } from "@openteam/contracts";
import type { ExternalDraft } from "@openteam/contracts/external-draft";
import { externalDraftReviewEdits } from "@openteam/client-core/external-draft";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useEffect, useRef, useState } from "react";
import { api } from "../../client/openteam-api";
export function ExternalDraftCard({
  message,
  draft,
}: {
  message: ChannelMessageView;
  draft: ExternalDraft;
}) {
  const inFlight = useRef(false);
  const metadata = message.metadata as Record<string, unknown>;
  const [state, setState] = useState(String(metadata.cardState ?? "pending"));
  const [body, setBody] = useState(draft.body);
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [to, setTo] = useState(draft.to?.join(", ") ?? "");
  const [cc, setCc] = useState(draft.cc?.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  useEffect(() => {
    setState(String(metadata.cardState ?? "pending"));
    if (metadata.cardState === "sent") setError("");
  }, [metadata.cardState]);
  const act = async (action: "save" | "send" | "cancel" | "refresh") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const edits = externalDraftReviewEdits(draft, action, { body, subject, to, cc });
      const result = await api.mutateExternalDraft(message.id, action, edits);
      setState(String((result.message.metadata as Record<string, unknown>).cardState));
      const nextMetadata = result.message.metadata as Record<string, unknown>;
      setOutcome(typeof nextMetadata.outcomeText === "string" ? nextMetadata.outcomeText : null);
    } catch (error) {
      setError(clientErrorMessage(error, "The draft could not be updated"));
      if (action === "send") {
        setState("unconfirmed");
        try {
          const checked = await api.mutateExternalDraft(message.id, "refresh");
          const next = checked.message.metadata as Record<string, unknown>;
          setState(String(next.cardState ?? "unconfirmed"));
          setOutcome(typeof next.outcomeText === "string" ? next.outcomeText : null);
          if (next.cardState === "sent") setError("");
        } catch {
          /* Keep Check delivery available until the server can confirm the result. */
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const inputClass = "w-full rounded-lg border bg-background p-2";
  return (
    <div className="rich-message-card flex w-full max-w-[560px] flex-col gap-3 rounded-2xl bg-[#eeeeee] p-4 text-sm dark:bg-[#262626]">
      <strong>Review {draft.platform === "email" ? "email" : "Slack message"}</strong>
      <p className="text-xs text-muted-foreground">
        Account:{" "}
        {String(
          (metadata.draft as { verification?: { identity: string } } | undefined)?.verification
            ?.identity ??
            draft.from ??
            draft.providerIdentifier
        )}
      </p>
      {draft.platform === "slack" && (
        <p>
          To: {draft.target} ({draft.channelId}){draft.threadTs ? " · Thread reply" : ""}
        </p>
      )}
      {draft.replyToMessageId && (
        <p className="text-xs">Reply to message {draft.replyToMessageId}</p>
      )}
      {state === "pending" ? (
        <>
          {draft.platform === "email" && (
            <>
              <label>
                To
                <input
                  aria-label="To"
                  className={inputClass}
                  disabled={busy}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label>
                Cc
                <input
                  aria-label="Cc"
                  className={inputClass}
                  disabled={busy}
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                />
              </label>
              <label>
                Subject
                <input
                  aria-label="Subject"
                  className={inputClass}
                  disabled={busy}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </label>
            </>
          )}
          <textarea
            aria-label="Message body"
            className={inputClass}
            disabled={busy}
            rows={7}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex justify-end gap-3">
            <button disabled={busy} onClick={() => void act("cancel")}>
              Cancel
            </button>
            <button disabled={busy} onClick={() => void act("save")}>
              Save
            </button>
            <button
              className="rounded-lg bg-foreground px-3 py-2 text-background"
              disabled={busy || !body.trim()}
              onClick={() => void act("send")}
            >
              {busy ? "Working…" : "Send"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            {state === "sending"
              ? "Sending…"
              : state === "sent"
                ? "Message sent"
                : state === "dismissed"
                  ? "Draft cancelled"
                  : String(
                      outcome ??
                        metadata.outcomeText ??
                        "Delivery needs checking. No automatic resend will occur."
                    )}
          </p>
          {(state === "sending" || state === "unconfirmed") && (
            <button disabled={busy} onClick={() => void act("refresh")}>
              Check delivery
            </button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
