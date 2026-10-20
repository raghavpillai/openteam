import "./external-draft-card.css";
import type { BotView, ChannelMessageView } from "@openteam/contracts";
import {
  externalDraftApprovalMode,
  type ExternalDraft,
  type ExternalDraftApprovalMode,
  type ExternalDraftVerification,
} from "@openteam/contracts/external-draft";
import { externalDraftReviewEdits } from "@openteam/client-core/external-draft";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../client/openteam-api";
import { LoadingOrb } from "../ui/loading-orb";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const addresses = (text: string) =>
  text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

/** Signature HTML from the mail provider, shown as text so nothing in it runs. */
export function signatureText(html: string): string {
  const document = new DOMParser().parseFromString(
    html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n"),
    "text/html"
  );
  return (document.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

type Tone = "ready" | "sent" | "warning" | "muted";
const STATUS: Record<string, { label: string; tone: Tone; dot: boolean }> = {
  pending: { label: "Ready to send", tone: "ready", dot: true },
  sending: { label: "Ready to send", tone: "ready", dot: true },
  sent: { label: "Sent", tone: "sent", dot: true },
  dismissed: { label: "Discarded", tone: "muted", dot: true },
  unknown: { label: "Unconfirmed", tone: "muted", dot: false },
  failed: { label: "Message not delivered", tone: "warning", dot: true },
  "draft-created": { label: "Message not delivered", tone: "warning", dot: true },
};
const MODE_LABEL: Record<ExternalDraftApprovalMode, string> = {
  "always-allow": "Always allow",
  "needs-approval": "Needs approval",
  "disable-drafts": "Disable drafts for Bot",
};

/** What changed, for the line under the card after the user picks a mode. */
export function approvalNotice(previous: ExternalDraftApprovalMode, next: ExternalDraftApprovalMode) {
  if (next === "always-allow") return "Added to your Allow rules";
  if (next === "disable-drafts") return "Drafts are off for this Bot";
  return previous === "disable-drafts" ? "Drafts need your approval again" : "Removed from your Allow rules";
}

function Status({ state }: { state: string }) {
  const status = STATUS[state] ?? STATUS.unknown!;
  return (
    <span className="draft-status" data-tone={status.tone} role="status">
      {status.dot && <span aria-hidden className="draft-status-dot" />}
      {status.label}
    </span>
  );
}

function Field({
  label,
  children,
  href,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  href?: string;
  htmlFor?: string;
}) {
  const content = (
    <>
      <span className="draft-label">{label}</span>
      <span className="draft-value">{children}</span>
    </>
  );
  if (href)
    return (
      <a className="draft-field" href={href} rel="noreferrer" target="_blank">
        {content}
      </a>
    );
  return htmlFor ? (
    <label className="draft-field" htmlFor={htmlFor}>
      <span className="draft-label">{label}</span>
      {children}
    </label>
  ) : (
    <div className="draft-field">{content}</div>
  );
}

/** A text button that opens a check-marked list above it, like the reference select. */
function Picker<T extends string>({
  label,
  value,
  options,
  display,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: T[];
  display: (value: T) => string;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const selected = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Open with the current choice highlighted, as the reference select does.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => selected.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <DropdownMenu.Root modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenu.Trigger aria-label={label} className="draft-trigger" disabled={disabled}>
        <span className="truncate">{value === "disable-drafts" ? "Disable drafts" : display(value)}</span>
        <ChevronDown aria-hidden className="draft-trigger-icon" strokeWidth={2.25} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          aria-label={label}
          className="draft-menu"
          side="top"
          sideOffset={4}
        >
          {options.map((option) => (
            <DropdownMenu.Item
              className="draft-menu-item"
              key={option}
              ref={option === value ? selected : undefined}
              onSelect={() => option !== value && onChange(option)}
            >
              <span>{display(option)}</span>
              {option === value && <Check aria-hidden className="draft-menu-check" strokeWidth={2.25} />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ExternalDraftCard({
  message,
  draft,
  bot,
}: {
  message: ChannelMessageView;
  draft: ExternalDraft;
  bot?: Pick<BotView, "draftingDisabled" | "draftAllowedRecipients">;
}) {
  const inFlight = useRef(false);
  const body = useRef<HTMLTextAreaElement>(null);
  const metadata = record(message.metadata);
  const verification = record(record(metadata.draft).verification) as Partial<ExternalDraftVerification>;
  const sendingAddresses = verification.sendingAddresses ?? [];
  const email = draft.platform === "email";
  const [state, setState] = useState(String(metadata.cardState ?? "pending"));
  const [from, setFrom] = useState(draft.from ?? "");
  const [text, setText] = useState(draft.body);
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [to, setTo] = useState(draft.to?.join(", ") ?? "");
  const [cc, setCc] = useState(draft.cc?.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // The send's response was lost and the server couldn't be asked yet.
  const [lost, setLost] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setState(String(metadata.cardState ?? "pending"));
    if (metadata.cardState === "sent") setError("");
  }, [metadata.cardState]);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > 272);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, state]);
  const sendError = typeof metadata.sendError === "string" ? metadata.sendError : "";
  const fields = { body: text, subject, to, cc, from };
  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const act = (action: "send" | "cancel") =>
    run(async () => {
      try {
        const edits = externalDraftReviewEdits(draft, action, fields, sendingAddresses);
        if (action === "send") setState("sending");
        const result = await api.mutateExternalDraft(message.id, action, edits);
        const next = record(result.message.metadata);
        setState(String(next.cardState ?? "pending"));
        if (typeof next.sendError === "string") setError(`Couldn't send this draft: ${next.sendError}`);
      } catch (failure) {
        setError(
          clientErrorMessage(
            failure,
            action === "send" ? "Couldn't send this draft" : "Couldn't discard this draft. Try again."
          )
        );
        if (action !== "send") return;
        // The server decides whether anything went out; never guess.
        try {
          const checked = await api.mutateExternalDraft(message.id, "refresh");
          setState(String(record(checked.message.metadata).cardState ?? "pending"));
        } catch {
          setState("sending");
          setLost(true);
        }
      }
    });
  const checkDelivery = () =>
    run(async () => {
      try {
        const checked = await api.mutateExternalDraft(message.id, "refresh");
        setState(String(record(checked.message.metadata).cardState ?? "pending"));
        setLost(false);
      } catch (failure) {
        setError(clientErrorMessage(failure, "Couldn't check delivery. Try again."));
      }
    });
  const mode = externalDraftApprovalMode(
    {
      draftingDisabled: bot?.draftingDisabled ?? false,
      draftAllowedRecipients: bot?.draftAllowedRecipients ?? [],
    },
    email ? { platform: "email", to: addresses(to), cc: addresses(cc) } : draft
  );
  const setMode = (next: ExternalDraftApprovalMode) =>
    run(async () => {
      setNotice("");
      try {
        const edits =
          state === "pending" ? externalDraftReviewEdits(draft, "approval", fields, sendingAddresses) : undefined;
        await api.setExternalDraftApproval(message.id, next, edits);
        setNotice(approvalNotice(mode, next));
      } catch (failure) {
        setError(clientErrorMessage(failure, "Couldn't save. Try again."));
      }
    });
  const sentUnder = record(metadata.sentUnder);
  const menu = bot ? (
    <Picker
      disabled={busy}
      display={(value) => MODE_LABEL[value]}
      label="Approval"
      onChange={(next) => void setMode(next)}
      options={email ? ["always-allow", "needs-approval", "disable-drafts"] : ["needs-approval", "disable-drafts"]}
      value={mode}
    />
  ) : null;
  const signature = email ? verification.signatures?.[from.toLowerCase()] : undefined;
  const title = email ? (draft.replyToMessageId ? "Reply" : "New email") : "Slack message";
  const header = (
    <div className="draft-header">
      <span className="draft-title">{title}</span>
      <Status state={state} />
    </div>
  );
  const replyRow =
    email && draft.replyToMessageId ? (
      <Field
        href={verification.threadUrl}
        label="In reply to"
      >
        {verification.thread ?? draft.replyToMessageId}
      </Field>
    ) : null;
  const notes = (
    <>
      {sentUnder.rule ? (
        <p className="draft-note">Auto-approved by your rule: {String(sentUnder.rule)}</p>
      ) : sentUnder.draftingDisabled ? (
        <p className="draft-note">Sent without review: drafts are off for this Bot</p>
      ) : null}
      {notice && <p className="draft-note">{notice}</p>}
      {(error || (state === "pending" && sendError)) && (
        <p className="draft-note" role="alert">
          {error || `Couldn't send this draft: ${sendError}`}
        </p>
      )}
    </>
  );

  if (state !== "pending" && state !== "sending") {
    const recipient = email ? (addresses(to)[0] ?? "") : (draft.target ?? "");
    const summary =
      state === "unknown"
        ? "The send was interrupted — check your mailbox to see whether it went out"
        : `${state === "sent" ? "Sent to" : "To"} ${recipient}${email ? ` — “${subject || draft.subject}”` : ""}`;
    const autoSent = Boolean(sentUnder.rule || sentUnder.draftingDisabled);
    return (
      <section aria-label={title} className="draft-card rich-message-card">
        {header}
        <span className="draft-summary" title={summary}>
          {summary}
        </span>
        {notes}
        {autoSent && <div className="draft-footer">{menu}</div>}
      </section>
    );
  }
  const sending = state === "sending";
  const locked = busy || sending;
  return (
    <form
      aria-label={title}
      className="draft-card rich-message-card"
      onSubmit={(event) => {
        event.preventDefault();
        void act("send");
      }}
    >
      {header}
      <div className="draft-panel">
        <div className="draft-fields">
          {email ? (
            <>
              <Field label="From">
                {sendingAddresses.length > 1 ? (
                  <Picker
                    disabled={locked}
                    display={(value) => value}
                    label="From"
                    onChange={setFrom}
                    options={sendingAddresses}
                    value={sendingAddresses.find((address) => address === from.toLowerCase()) ?? from}
                  />
                ) : (
                  from
                )}
              </Field>
              {replyRow}
              <Field htmlFor={`${message.id}-to`} label="To">
                <textarea
                  aria-label="To"
                  autoComplete="off"
                  className="draft-input"
                  disabled={locked}
                  id={`${message.id}-to`}
                  onChange={(event) => setTo(event.target.value.replace(/[\r\n]+/g, " "))}
                  placeholder="name@example.com"
                  rows={1}
                  spellCheck={false}
                  value={to}
                />
              </Field>
              <Field htmlFor={`${message.id}-cc`} label="Cc">
                <textarea
                  aria-label="Cc"
                  autoComplete="off"
                  className="draft-input"
                  disabled={locked}
                  id={`${message.id}-cc`}
                  onChange={(event) => setCc(event.target.value.replace(/[\r\n]+/g, " "))}
                  placeholder="name@example.com"
                  rows={1}
                  spellCheck={false}
                  value={cc}
                />
              </Field>
              <Field htmlFor={`${message.id}-subject`} label="Subject">
                <textarea
                  aria-label="Subject"
                  autoComplete="off"
                  className="draft-input"
                  disabled={locked}
                  id={`${message.id}-subject`}
                  onChange={(event) => setSubject(event.target.value.replace(/[\r\n]+/g, " "))}
                  placeholder="Subject"
                  rows={1}
                  value={subject}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Workspace">{verification.identity}</Field>
              <Field label="To">{draft.target}</Field>
              {draft.threadTs && <Field label="In thread">{verification.thread?.split("\n")[0] ?? draft.threadTs}</Field>}
            </>
          )}
        </div>
        <textarea
          aria-label="Message body"
          className="draft-body"
          data-clamped={overflowing && !expanded ? "" : undefined}
          dir="auto"
          disabled={locked}
          name="body"
          onChange={(event) => setText(event.target.value)}
          placeholder="Write a message"
          ref={body}
          rows={4}
          value={text}
        />
        {overflowing && (
          <button className="draft-toggle" onClick={() => setExpanded((open) => !open)} type="button">
            {expanded ? "Show less" : "Show more"}
            {expanded ? (
              <ChevronUp aria-hidden className="draft-trigger-icon" strokeWidth={2.25} />
            ) : (
              <ChevronDown aria-hidden className="draft-trigger-icon" strokeWidth={2.25} />
            )}
          </button>
        )}
        {signature && <div className="draft-signature">{signatureText(signature)}</div>}
      </div>
      {notes}
      <div className="draft-footer">
        <div className="draft-actions">
          <button
            className="draft-button draft-button-primary"
            data-sending={sending ? "" : undefined}
            disabled={locked || !text.trim()}
            type="submit"
          >
            {sending && <LoadingOrb aria-hidden size={14} />}
            {sending ? "Sending…" : "Send"}
          </button>
          {lost ? (
            <button
              className="draft-button draft-button-secondary"
              disabled={busy}
              onClick={() => void checkDelivery()}
              type="button"
            >
              Check delivery
            </button>
          ) : (
            <button
              className="draft-button draft-button-secondary"
              disabled={locked}
              onClick={() => void act("cancel")}
              type="button"
            >
              Discard
            </button>
          )}
        </div>
        {menu}
      </div>
    </form>
  );
}
