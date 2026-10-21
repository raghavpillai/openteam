import "./external-draft-card.css";
import "./approval-card.css";
import type { BotView, ChannelMessageView } from "@openteam/contracts";
import {
  approvalSettledNote,
  approvalStatusLabel,
  type ApprovalCard as ApprovalCardMetadata,
  type ApprovalCardState,
  type ApprovalDecision,
} from "@openteam/contracts/auto-review";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { ChevronDown, ChevronUp, Laptop, Plug, ShieldCheck, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../client/openteam-api";
import { LoadingOrb } from "../ui/loading-orb";

const SOURCE_ICONS = { terminal: SquareTerminal, computer: Laptop, plug: Plug, shield: ShieldCheck } as const;
/** The reference app truncates the request in the card at 340 characters. */
const DETAIL_MAX_CHARS = 340;
const TONES: Partial<Record<ApprovalCardState, string>> = { approved: "sent", always: "sent", denied: "warning", expired: "muted" };

export function detailText(command: string) {
  if (command.length <= DETAIL_MAX_CHARS) return command;
  const omitted = command.length - DETAIL_MAX_CHARS;
  return `${command.slice(0, DETAIL_MAX_CHARS)}...[${omitted} ${omitted === 1 ? "char" : "chars"} omitted]`;
}

/** The Auto-review approval card: what the action is, why it needs approval, and Allow / Deny. */
export function ApprovalCardView({
  card,
  botName,
  busy,
  answering,
  error,
  onAnswer,
}: {
  card: ApprovalCardMetadata;
  botName: string;
  busy: boolean;
  answering?: ApprovalDecision | null;
  error?: string;
  onAnswer: (decision: ApprovalDecision) => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = card.cardState === "pending";
  const { presentation } = card;
  const Icon = SOURCE_ICONS[presentation.sourceIcon] ?? ShieldCheck;
  const askFirst = card.appliedRules?.find((rule) => rule.effect === "ask_first");
  const allowedBy = card.appliedRules?.find((rule) => rule.effect === "allow");
  const settledNote = approvalSettledNote(card, botName);
  const detail = card.command ?? card.fullRequest;
  const button = (decision: ApprovalDecision, label: string, variant: "primary" | "secondary", title?: string) => (
    <button
      className={`draft-button draft-button-${variant}`}
      disabled={busy}
      onClick={() => onAnswer(decision)}
      title={title}
      type="button"
    >
      {answering === decision && <LoadingOrb aria-hidden size={14} />}
      {label}
    </button>
  );
  return (
    <section
      aria-label={`${presentation.title}: ${presentation.line.replace(/[.!?]+$/u, "")}`}
      className="draft-card approval-card rich-message-card"
      data-state={card.cardState}
      onKeyDown={(event) => {
        if (pending && !busy && event.key === "Escape") {
          event.preventDefault();
          onAnswer("denied");
        }
      }}
    >
      <div className="approval-source">
        <Icon aria-hidden className="approval-source-icon" strokeWidth={1.75} />
        <span>{presentation.source}</span>
      </div>
      <div className="draft-header">
        <span className="draft-title approval-title">{presentation.title}</span>
        <span className="draft-status" data-tone={pending ? "ready" : (TONES[card.cardState] ?? "muted")} role="status">
          <span aria-hidden className="draft-status-dot" />
          {pending ? "Needs approval" : approvalStatusLabel(card.cardState)}
        </span>
      </div>
      <p className="approval-line">{presentation.line}</p>
      {presentation.quote && <p className="approval-quote">“{presentation.quote}”</p>}
      {pending && presentation.caution && <p className="approval-caution">{presentation.caution}</p>}
      {pending && askFirst && <p className="draft-note">Paused by your Ask first rule: {askFirst.text}</p>}
      {pending && !askFirst && allowedBy && <p className="draft-note">Auto-approved by your rule: {allowedBy.text}</p>}
      <div className="approval-disclosure">
        <button aria-expanded={open} className="draft-toggle" onClick={() => setOpen((value) => !value)} type="button">
          View the full request
          {open ? <ChevronUp aria-hidden className="draft-trigger-icon" strokeWidth={2.25} /> : <ChevronDown aria-hidden className="draft-trigger-icon" strokeWidth={2.25} />}
        </button>
        {open && (
          <div className="approval-detail">
            <p className="approval-reason">{card.reason}</p>
            {detail && <pre className="approval-command">{detailText(detail)}</pre>}
          </div>
        )}
      </div>
      {pending && card.proposedRule && <p className="draft-note">Always allow saves: {card.proposedRule}</p>}
      {!pending && settledNote && <p className="draft-note">{settledNote}</p>}
      {error && (
        <p className="draft-note" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <div className="draft-footer">
          <div className="draft-actions">
            {card.proposedRule && button("always", "Always allow", "secondary")}
            {button("approved", card.proposedRule ? "Allow once" : "Allow", "primary")}
            {button("denied", "Deny", "secondary", "Deny once (Esc)")}
          </div>
        </div>
      )}
    </section>
  );
}

export function ApprovalCard({ message, bot }: { message: ChannelMessageView; bot?: BotView }) {
  const inFlight = useRef(false);
  const [card, setCard] = useState(message.metadata as unknown as ApprovalCardMetadata);
  const [answering, setAnswering] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState("");
  useEffect(() => setCard(message.metadata as unknown as ApprovalCardMetadata), [message.metadata]);
  if (!card?.presentation) return null;
  const answer = async (decision: ApprovalDecision) => {
    if (inFlight.current || card.cardState !== "pending") return;
    inFlight.current = true;
    setAnswering(decision);
    setError("");
    try {
      const result = await api.answerApproval(message.id, decision);
      setCard(result.message.metadata as unknown as ApprovalCardMetadata);
    } catch (failure) {
      setError(clientErrorMessage(failure, "Your answer didn't go through. Check your connection and try again."));
    } finally {
      inFlight.current = false;
      setAnswering(null);
    }
  };
  return (
    <ApprovalCardView
      answering={answering}
      botName={bot?.name ?? "OpenTeam"}
      busy={answering !== null}
      card={card}
      error={error}
      onAnswer={(decision) => void answer(decision)}
    />
  );
}
