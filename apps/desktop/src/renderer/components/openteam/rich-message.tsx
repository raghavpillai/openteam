import "./permission-cards.css";
import { ReviewActionCard } from "./review-action-card";
import { parseExternalDraft } from "@openteam/contracts/external-draft";
import { ExternalDraftCard } from "./external-draft-card";
import type {
  ChannelMessageView,
  RichMessageComputerHandoff as ComputerHandoff,
  RichMessageSecretRequest as SecretRequest,
  RichMessageWidget as Widget,
  RichMessageWidgetOption as WidgetOption,
} from "@openteam/contracts";
import {
  parseRichMessageComputerHandoff as computerHandoffFrom,
  parseRichMessageSecretRequest as secretFrom,
  parseRichMessageWidget as widgetFrom,
  resolvedWidgetAnswers,
  createWidgetDraftStore,
  richMessageMetadata as record,
  secretRequestPlaceholder,
  toggleWidgetSelection,
  type RichMessageMetadata as RichMetadata,
  widgetOptionLetter,
  widgetOptionValue as optionValue,
  widgetResponseValue,
} from "@openteam/product-core/rich-messages";
import { MonitorUp } from "lucide-react";
import { PermissionIcon } from "./permission-icon";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { API_BASE } from "../../client/http";
import { api } from "../../client/openteam-api";
import { cn } from "../../lib/cn";
import { openComputerHandoff } from "../../lib/computer-handoff";
import { parseUserForm } from "@openteam/contracts/review-cards";
import { UserFormCard } from "./user-form-card";

const editableTarget = (target: EventTarget | null) =>
  (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
  (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement) ||
  (typeof HTMLSelectElement !== "undefined" && target instanceof HTMLSelectElement) ||
  (typeof HTMLElement !== "undefined" && target instanceof HTMLElement && target.isContentEditable);

type RichWidgetShortcutHandler = (event: KeyboardEvent) => void;

/**
 * One capture listener serves every pending widget in a document. The DOM
 * query preserves the existing "latest visible pending card wins" behavior,
 * while the registry avoids one document listener and one full query per card.
 */
export const createRichWidgetShortcutDelegate = (ownerDocument: Document) => {
  const handlers = new Map<HTMLElement, { handle: RichWidgetShortcutHandler }>();

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      event.key.length !== 1 ||
      editableTarget(event.target) ||
      editableTarget(ownerDocument.activeElement) ||
      ownerDocument.querySelector('[role="dialog"], [aria-modal="true"]')
    ) {
      return;
    }
    const cards = ownerDocument.querySelectorAll<HTMLElement>('[data-rich-widget-state="pending"]');
    const latest = cards.item(cards.length - 1);
    if (!latest) return;
    handlers.get(latest)?.handle(event);
  };

  const register = (root: HTMLElement, handle: RichWidgetShortcutHandler) => {
    const registration = { handle };
    const needsListener = handlers.size === 0;
    handlers.set(root, registration);
    if (needsListener) ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => {
      if (handlers.get(root) !== registration) return;
      handlers.delete(root);
      if (handlers.size === 0) ownerDocument.removeEventListener("keydown", onKeyDown, true);
    };
  };

  return { register };
};

const richWidgetShortcutDelegates = new WeakMap<
  Document,
  ReturnType<typeof createRichWidgetShortcutDelegate>
>();

const registerRichWidgetShortcut = (root: HTMLElement, handle: RichWidgetShortcutHandler) => {
  const ownerDocument = root.ownerDocument;
  let delegate = richWidgetShortcutDelegates.get(ownerDocument);
  if (!delegate) {
    delegate = createRichWidgetShortcutDelegate(ownerDocument);
    richWidgetShortcutDelegates.set(ownerDocument, delegate);
  }
  return delegate.register(root, handle);
};

const cardClass =
  "permission-surface rich-message-card flex w-full max-w-[520px] min-w-0 flex-col gap-2.5 overflow-hidden rounded-2xl bg-[#eeeeee] p-3 text-[13px] text-[#141414] dark:bg-[#262626] dark:text-[#f0f0f0]";
const secondaryText = "permission-secondary";
const optionGroupClass = "widget-options";
const optionRowClass = "widget-option";
const optionKeyClass = "widget-option-key";

function ResolvedWidget({ metadata, widget }: { metadata: RichMetadata; widget: Widget }) {
  const answer = String(metadata.respondedValue ?? "");
  const answers = resolvedWidgetAnswers(widget, answer);
  return (
    <section className={cn(cardClass, "permission-widget")} data-rich-widget-state="resolved" role="group">
      <p className="m-0 min-w-0 text-[14px] font-medium leading-5">{widget.prompt}</p>
      <div aria-label="Your answer" className={optionGroupClass} role="group">
        {answers.map(({ value, label, optionIndex }, index) => {
          return (
            <Fragment key={value}>
            {index > 0 && <div className="widget-divider" />}
            <div className="widget-option widget-option-resolved">
              {optionIndex !== null ? (
                <span aria-hidden="true" className={optionKeyClass}><span>{widgetOptionLetter(optionIndex)}</span></span>
              ) : null}
              <span className="widget-option-label min-w-0 flex-1">{label}</span>
              <span className="inline-flex w-4 shrink-0"><PermissionIcon name="check" className="size-3.5" /></span>
            </div>
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

function DismissedWidget({ widget }: { widget: Widget }) {
  return (
    <section
      aria-disabled="true"
      className={cn(cardClass, "permission-widget flex-row items-start gap-2")}
      data-rich-widget-state="dismissed"
      role="group"
    >
      <p className={cn("m-0 min-w-0 flex-1 text-[14px] font-medium leading-5", secondaryText)}>
        {widget.prompt}
      </p>
      <span className="widget-dismissed-pill">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> <span>Dismissed</span>
      </span>
    </section>
  );
}

const widgetDrafts = createWidgetDraftStore();

function WidgetCard({
  message,
  metadata,
  widget,
}: {
  message: ChannelMessageView;
  metadata: RichMetadata;
  widget: Widget;
}) {
  const [localMetadata, setLocalMetadata] = useState(metadata);
  const draftKey = JSON.stringify([API_BASE, message.id, widget]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(widgetDrafts.read(draftKey).selected)
  );
  const [custom, setCustom] = useState(() => widgetDrafts.read(draftKey).custom);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const authoritative = useRef(metadata);
  authoritative.current = metadata;
  const rootRef = useRef<HTMLFormElement>(null);
  const shortcutHandlerRef = useRef<RichWidgetShortcutHandler>(() => undefined);
  const titleId = useId();
  useEffect(() => {
    setLocalMetadata(metadata);
    setError("");
  }, [metadata]);
  const settled =
    typeof localMetadata.respondedValue === "string" || localMetadata.widgetDismissed === true;
  useEffect(() => {
    if (settled && !pending) widgetDrafts.clear(draftKey);
    else widgetDrafts.write(draftKey, custom, selected);
  }, [draftKey, settled, pending, custom, selected]);
  const selectedValue = useMemo(
    () => widgetResponseValue(widget, selected, custom),
    [custom, selected, widget]
  );

  const mutate = async (value?: string) => {
    if (inFlight.current || settled || (value !== undefined && !value.trim())) return;
    inFlight.current = true;
    const previous = authoritative.current;
    setPending(true);
    setError("");
    setLocalMetadata({ ...previous, ...(value === undefined ? { widgetDismissed: true } : { respondedValue: value }) });
    try {
      const result =
        value === undefined
          ? await api.dismissWidget(message.id)
          : await api.respondToWidget(message.id, value);
      // Even a rejected duplicate contains the authoritative answer/dismissal.
      if (authoritative.current === previous) {
        const next = record(result.message.metadata);
        setLocalMetadata(next);
        if (
          !result.accepted &&
          typeof next.respondedValue !== "string" &&
          next.widgetDismissed !== true
        )
          setError("We couldn't confirm your answer. Check this card before trying again.");
      }
    } catch {
      if (authoritative.current === previous) {
        setLocalMetadata(previous);
        setError("We couldn't confirm your answer. Check the card in a moment before trying again.");
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const submit = (value: string) => mutate(value);
  const dismiss = () => mutate();

  const choose = (value: string) => {
    if (inFlight.current || settled) return;
    if (!widget.multiSelect) {
      void submit(value);
      return;
    }
    setSelected((current) => {
      return new Set(toggleWidgetSelection(current, value));
    });
  };

  shortcutHandlerRef.current = (event) => {
    const option = widget.options[event.key.toUpperCase().charCodeAt(0) - 65];
    if (!option) return;
    event.preventDefault();
    choose(optionValue(option));
  };

  useEffect(() => {
    const root = rootRef.current;
    if (settled || !root) return;
    return registerRichWidgetShortcut(root, (event) => shortcutHandlerRef.current(event));
  }, [settled]);

  if (typeof localMetadata.respondedValue === "string") {
    return <ResolvedWidget metadata={localMetadata} widget={widget} />;
  }
  if (localMetadata.widgetDismissed === true) return <DismissedWidget widget={widget} />;

  return (
    <form
      aria-labelledby={titleId}
      className={cn(cardClass, "permission-widget")}
      data-rich-widget-state="pending"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(widget.multiSelect ? selectedValue : custom.trim());
      }}
      ref={rootRef}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="m-0 min-w-0 text-[14px] font-medium leading-5" id={titleId}>
            {widget.prompt}
          </p>
          {widget.helpText ? (
            <p className={cn("m-0 min-w-0 leading-5", secondaryText)}>{widget.helpText}</p>
          ) : null}
        </div>
        <button
          aria-label="Dismiss question"
          className="grid size-5 shrink-0 place-items-center rounded-md text-[#141414]/60 dark:text-[#f0f0f0]/60 hover:bg-black/[0.06] disabled:opacity-40 dark:hover:bg-white/[0.07]"
          disabled={pending}
          onClick={() => void dismiss()}
          title="Dismiss without answering"
          type="button"
        >
          <PermissionIcon name="close" className="size-3" />
        </button>
      </div>
      <div className={optionGroupClass}>
        {widget.options.map((option, index) => {
          const value = optionValue(option);
          const active = selected.has(value);
          return (
            <Fragment key={`${value}-${index}`}>
            {index > 0 && <div className="widget-divider" />}
            <button
              aria-keyshortcuts={widgetOptionLetter(index).toLowerCase()}
              aria-pressed={widget.multiSelect ? active : undefined}
              className={optionRowClass}
              disabled={pending}
              key={`${value}-${index}`}
              onClick={() => choose(value)}
              type="button"
            >
              <span aria-hidden="true" className={optionKeyClass}><span>{widgetOptionLetter(index)}</span></span>
              <span className="min-w-0 flex-1">
                <span className="widget-option-label">{option.label}</span>
                {option.description ? (
                  <span className="widget-option-description">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {active ? <span className="inline-flex w-4 shrink-0"><PermissionIcon name="check" className="size-3.5" /></span> : null}
            </button>
            </Fragment>
          );
        })}
      </div>
      {widget.allowCustom ? (
        <div className="flex w-full min-w-0 items-start gap-2">
          <div className="widget-custom">
            <textarea
              aria-label="Custom answer"
              autoComplete="off"

              disabled={pending}
              onChange={(event) => {
                setCustom(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit(widget.multiSelect ? selectedValue : custom.trim());
                }
              }}
              placeholder="Type your own answer"
              rows={1}
              spellCheck={false}
              value={custom}
            />
          </div>
          {custom.trim() && !widget.multiSelect ? (
            <button
              className="rich-message-submit widget-submit shrink-0 disabled:opacity-40"
              disabled={pending}
              type="submit"
            >
              Submit
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-xs text-red-600">
          {error}
        </p>
      ) : null}
      {widget.multiSelect && selectedValue ? (
        <div className="flex w-full justify-end">
          <button
            className="widget-submit disabled:opacity-40"
            disabled={pending}
            type="submit"
          >
            Submit
          </button>
        </div>
      ) : null}
    </form>
  );
}

function SecretCard({
  message,
  metadata,
  request,
}: {
  message: ChannelMessageView;
  metadata: RichMetadata;
  request: SecretRequest;
}) {
  const [provided, setProvided] = useState(metadata.secretProvided === true);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const authoritative = useRef(metadata);
  authoritative.current = metadata;
  const titleId = useId();
  useEffect(() => {
    setProvided(metadata.secretProvided === true);
    if (metadata.secretProvided === true) {
      setValue("");
      setError("");
    }
  }, [metadata.secretProvided]);
  const botSecret = !!request.name && request.scope !== "personal";
  const variableNote = request.name ? <span className="permission-copy">Saved securely {botSecret ? "for all users of this bot" : "for you"} and exposed as {request.name}</span> : null;
  if (provided) {
    return (
      <section aria-labelledby={titleId} className={cn(cardClass, "permission-receipt")}>
        <span className="permission-receipt-copy">
          <span className="permission-title" id={titleId}>{request.label}</span>
          {variableNote}
          <span className="permission-copy">{botSecret ? "Saved for all users of this bot. Configure in bot settings." : "Saved securely and kept private."}</span>
        </span>
        <span className="permission-pill permission-pill-success">
          <PermissionIcon name="check" className="size-3" /><span className="permission-pill-label">Saved</span>
        </span>
      </section>
    );
  }
  return (
    <form
      aria-labelledby={titleId}
      className={cn(cardClass, "permission-secret")}
      onSubmit={async (event) => {
        event.preventDefault();
        const secret = value;
        if (!secret.trim() || inFlight.current || provided) return;
        inFlight.current = true;
        const previous = authoritative.current;
        setError("");
        setValue("");
        setPending(true);
        try {
          const result = await api.submitSecret(message.id, secret);
          if (result.accepted || record(result.message.metadata).secretProvided === true) {
            setProvided(true);
          } else if (authoritative.current === previous) {
            setError("This value could not be saved. Enter it again to retry.");
          }
        } catch {
          if (authoritative.current === previous)
            setError(
              "We couldn't confirm this value was saved. Check this card before entering it again."
            );
        } finally {
          inFlight.current = false;
          setPending(false);
        }
      }}
    >
      <div className="flex min-w-0 flex-col">
        <span className="permission-title" id={titleId}>{request.label}</span>
        {variableNote}
        {request.description ? (
          <p className="permission-copy">{request.description}</p>
        ) : null}
      </div>
      <div className="flex w-full min-w-0 items-start gap-2">
        <input
          aria-labelledby={titleId}
          autoComplete="off"
          className="permission-input h-8 min-w-0 flex-1"
          disabled={pending}
          onChange={(event) => setValue(event.currentTarget.value)}
          placeholder={secretRequestPlaceholder(request.label)}
          spellCheck={false}
          type="password"
          value={value}
        />
        <button
          className="permission-button permission-button-primary"
          disabled={!value.trim() || pending}
          type="submit"
        >
          Save securely
        </button>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-xs text-red-600">
          {error}
        </p>
      ) : null}
      <div className={cn("permission-secret-note flex min-w-0 items-center gap-1 text-[13px] leading-[18px] tracking-[-0.08px]", secondaryText)}>
        <span className="flex shrink-0">
          <PermissionIcon name="shield" className="size-3" />
        </span>
        <span className="min-w-0">{botSecret ? "Saved for all users of this bot. Never shown to other bots." : "Stored securely, never shown to your Bot."}</span>
      </div>
    </form>
  );
}

function ComputerHandoffCard({
  message,
  metadata,
  handoff,
}: {
  message: ChannelMessageView;
  metadata: RichMetadata;
  handoff: ComputerHandoff;
}) {
  const [state, setState] = useState(
    typeof metadata.computerHandoffState === "string" ? metadata.computerHandoffState : "requested"
  );
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const authoritative = useRef(metadata);
  authoritative.current = metadata;
  useEffect(() => {
    setError("");
    setState(
      typeof metadata.computerHandoffState === "string"
        ? metadata.computerHandoffState
        : "requested"
    );
  }, [metadata.computerHandoffState]);
  const terminal = ["completed", "skipped", "dismissed"].includes(state);
  const mutate = async (action: "start" | "skip") => {
    if (inFlight.current || terminal || (action === "start" && !message.senderBotId)) return;
    inFlight.current = true;
    const previous = authoritative.current;
    setPending(true);
    setError("");
    try {
      const result = await api.mutateComputerHandoff(message.id, action);
      if (authoritative.current !== previous) return;
      const next = record(result.message.metadata).computerHandoffState;
      if (typeof next === "string") setState(next);
      if (action === "start" && next === "active" && message.senderBotId) {
        openComputerHandoff({ botId: message.senderBotId, messageId: message.id });
      } else if (
        !result.accepted &&
        !["completed", "skipped", "dismissed"].includes(String(next))
      ) {
        setError("The computer request could not be updated. Check this card before trying again.");
      }
    } catch {
      if (authoritative.current === previous)
        setError("The computer request could not be updated. Check this card before trying again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <section className={cardClass} role="group">
      <div className="flex min-w-0 items-start gap-2.5">
        <MonitorUp className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">Take over the computer</div>
          <p className={cn("m-0 mt-0.5 leading-5", secondaryText)}>{handoff.reason}</p>
        </div>
      </div>
      {!terminal && error ? (
        <p role="alert" className="m-0 text-xs text-red-600">
          {error}
        </p>
      ) : null}
      {terminal ? (
        <div className={cn("text-xs font-medium capitalize", secondaryText)}>{state}</div>
      ) : (
        <div className="flex justify-end gap-2">
          <button
            className="h-8 rounded-lg px-2.5 font-medium text-foreground-secondary hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
            disabled={pending}
            onClick={() => void mutate("skip")}
            type="button"
          >
            Skip
          </button>
          <button
            className="h-8 rounded-lg bg-[#141414] px-2.5 font-medium text-white disabled:opacity-40 dark:bg-[#f0f0f0] dark:text-[#181818]"
            disabled={pending || !message.senderBotId}
            onClick={() => void mutate("start")}
            type="button"
          >
            {state === "active" ? "Return to computer" : "Take over"}
          </button>
        </div>
      )}
    </section>
  );
}

export function RichMessage({ message }: { message: ChannelMessageView }) {
  const metadata = record(message.metadata);
  if (metadata.type === "review-action" && metadata.review && typeof metadata.review === "object")
    return <ReviewActionCard message={message} />;
  if (metadata.type === "external-draft") {
    try {
      return <ExternalDraftCard draft={parseExternalDraft(metadata.draft)} message={message} />;
    } catch {
      return null;
    }
  }
  if (metadata.type === "user-form") {
    try {
      return <UserFormCard form={parseUserForm(metadata.form)} message={message} />;
    } catch {
      return null;
    }
  }
  if (metadata.type === "widget") {
    const widget = widgetFrom(metadata.widget);
    return widget ? <WidgetCard message={message} metadata={metadata} widget={widget} /> : null;
  }
  if (metadata.type === "secret-request") {
    const request = secretFrom(metadata.secretRequest ?? metadata.secret);
    return request ? <SecretCard message={message} metadata={metadata} request={request} /> : null;
  }
  if (metadata.type === "computer-handoff") {
    const handoff = computerHandoffFrom(metadata.computerHandoff);
    return handoff ? (
      <ComputerHandoffCard handoff={handoff} message={message} metadata={metadata} />
    ) : null;
  }
  return null;
}
