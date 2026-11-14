import { ButtonPrimitive } from "../ui/button-primitive";
import "./permission-cards.css";
import { SharedTemplateCard } from "./shared-template-card";
import { parseExternalDraft } from "@openteam/contracts/external-draft";
import { ExternalDraftCard } from "./external-draft-card";
import { IMessageSendCard } from "./imessage-send-card";
import type {
  BotView,
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
import {
  Component,
  createRef,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { MessageResponse, MessageRendererBoundary } from "../ai-elements/message";
const PresentationMessage = lazy(() => import("./presentation/presentation-message"));
import { API_BASE } from "../../client/http";
import { api } from "../../client/openteam-api";
import { cn } from "../../lib/cn";
import { openComputerHandoff } from "../../lib/computer-handoff";
import { parseUserForm } from "@openteam/contracts/user-forms";
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

const questionGlyphs = {
  check: ["M3.5 8.4l3 3 6-6.6"],
  pencil: ["M10.4 3l2.6 2.6", "M2.8 13.2l.6-3.1L11 2.5a1.3 1.3 0 0 1 1.8 0l.7.7a1.3 1.3 0 0 1 0 1.8l-7.6 7.6-3.1.6z"],
  send: ["M8 12.8V3.2", "M4 7.2l4-4 4 4"],
  skip: ["M3.5 3.8l6 4.2-6 4.2V3.8z", "M12.5 3.8v8.4"],
  chat: ["M2.5 8a5.5 5.5 0 1 1 2.6 4.67L2.5 13.5l.83-2.6A5.47 5.47 0 0 1 2.5 8z"],
  replace: ["M3 5.5h9.5", "M10.2 3.2l2.3 2.3-2.3 2.3", "M13 10.5H3.5", "M5.8 8.2L3.5 10.5l2.3 2.3"],
} as const;

function QuestionGlyph({ name }: { name: keyof typeof questionGlyphs }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
    >
      {questionGlyphs[name].map((d) => (
        <path d={d} key={d} pathLength={name === "check" ? 1 : undefined} />
      ))}
    </svg>
  );
}

type QuestionMotion = typeof import("./question-card-motion");
let questionMotion: QuestionMotion | undefined;
let questionMotionLoad: Promise<unknown> | undefined;

/**
 * The frame is the card's visible surface. Its motion (arrival, the answer and
 * skip morphs, the closing height) loads with the first question card, so it
 * stays out of startup; until then, and under Reduce Motion, cards just change.
 * `state` is the card's lifecycle state: a change is what gets animated.
 */
class QuestionFrame extends Component<{ children: ReactNode; state: number }> {
  frame = createRef<HTMLDivElement>();
  motion: ReturnType<QuestionMotion["attachQuestionMotion"]> | undefined;
  componentDidMount() {
    const attach = () => {
      const frame = this.frame.current;
      if (frame && !this.motion) this.motion = questionMotion?.attachQuestionMotion(frame);
    };
    if (questionMotion) return attach();
    questionMotionLoad ??= import("./question-card-motion").then(
      (motion) => (questionMotion = motion),
      () => undefined
    );
    void questionMotionLoad.then(attach);
  }
  getSnapshotBeforeUpdate(previous: { state: number }) {
    return (previous.state !== this.props.state && this.motion?.before()) || null;
  }
  componentDidUpdate(previous: { state: number }, _state: unknown, shot: unknown) {
    if (previous.state !== this.props.state) this.motion?.after(shot);
  }
  componentWillUnmount() {
    this.motion?.detach();
    this.motion = undefined;
  }
  render() {
    return (
      <div data-rich-widget-frame className="w-full max-w-[520px] min-w-0 overflow-hidden rounded-2xl" ref={this.frame}>
        <div>{this.props.children}</div>
      </div>
    );
  }
}

function ResolvedWidget({ metadata, widget }: { metadata: RichMetadata; widget: Widget }) {
  const answer = String(metadata.respondedValue ?? "");
  const answers = resolvedWidgetAnswers(widget, answer);
  return (
    <section className={cn(cardClass, "permission-widget question-card")} data-rich-widget-state="resolved" role="group">
      <p className="question-prompt question-prompt-settled">{widget.prompt}</p>
      <div aria-label="Your answer" className="question-answers" role="group">
        {answers.map(({ value, label, optionIndex }) => (
          <div className="question-answer" data-option={optionIndex ?? undefined} key={value}>
            <span className="question-answer-check">
              <QuestionGlyph name="check" />
            </span>
            <span className="widget-option-label min-w-0 flex-1">{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DismissedWidget({ widget, metadata }: { widget: Widget; metadata: RichMetadata }) {
  const [label, explanation, glyph] = metadata.widgetDismissalReason === "moved-on"
    ? (["Continued in chat", "This question closed when you sent a message.", "chat"] as const)
    : metadata.widgetDismissalReason === "superseded"
      ? (["Replaced", "A newer question took its place.", "replace"] as const)
      : (["Skipped", "No answer was sent from this card.", "skip"] as const);
  return (
    <section
      aria-disabled="true"
      className={cn(cardClass, "permission-widget question-card question-closed")}
      data-rich-widget-state="dismissed"
      role="group"
      title={explanation}
    >
      <p className="question-prompt question-prompt-settled min-w-0 flex-1">{widget.prompt}</p>
      <span className="widget-dismissed-pill">
        <QuestionGlyph name={glyph} />
        {label}
      </span>
      <span className="sr-only">{explanation}</span>
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
  const customRef = useRef<HTMLTextAreaElement>(null);
  const shortcutHandlerRef = useRef<RichWidgetShortcutHandler>(() => undefined);
  const titleId = useId();
  useEffect(() => {
    setLocalMetadata(metadata);
    setError("");
  }, [metadata]);
  // 0 while it waits, 1 answered, 2 closed without an answer.
  const state = typeof localMetadata.respondedValue === "string" ? 1 : localMetadata.widgetDismissed === true ? 2 : 0;
  const settled = state > 0;
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
    setLocalMetadata({ ...previous, ...(value === undefined ? { widgetDismissed: true, widgetDismissalReason: "dismissed" } : { respondedValue: value }) });
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
          setError("We couldn't confirm this change. Check the card before trying again.");
      }
    } catch {
      if (authoritative.current === previous) {
        setLocalMetadata(previous);
        setError("We couldn't confirm this change. Check the card in a moment before trying again.");
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
    const index = event.key.toUpperCase().charCodeAt(0) - 65;
    if (widget.allowCustom && index === widget.options.length) {
      event.preventDefault();
      customRef.current?.focus();
      return;
    }
    const option = widget.options[index];
    if (!option) return;
    event.preventDefault();
    choose(optionValue(option));
  };

  useEffect(() => {
    const root = rootRef.current;
    if (settled || !root) return;
    return registerRichWidgetShortcut(root, (event) => shortcutHandlerRef.current(event));
  }, [settled]);

  const multi = widget.multiSelect === true;
  const customLetter = widgetOptionLetter(widget.options.length);
  return (
    <QuestionFrame state={state}>
      {state === 1 ? (
        <ResolvedWidget metadata={localMetadata} widget={widget} />
      ) : state ? (
        <DismissedWidget metadata={localMetadata} widget={widget} />
      ) : (
        <form
          aria-labelledby={titleId}
          className={cn(cardClass, "permission-widget question-card")}
          data-question-mode={multi ? "multi" : "single"}
          data-rich-widget-state="pending"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(multi ? selectedValue : custom.trim());
          }}
          ref={rootRef}
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="question-prompt" id={titleId}>
              {widget.prompt}
            </p>
            {widget.helpText ? <p className="question-help">{widget.helpText}</p> : null}
          </div>
          <div className="widget-options">
            {widget.options.map((option, index) => {
              const value = optionValue(option);
              const active = selected.has(value);
              return (
                <ButtonPrimitive
                  aria-keyshortcuts={widgetOptionLetter(index).toLowerCase()}
                  aria-pressed={multi ? active : undefined}
                  className="widget-option"
                  data-tone={option.style === "danger" ? "danger" : undefined}
                  disabled={pending}
                  key={`${value}-${index}`}
                  onClick={() => choose(value)}
                  type="button"
                >
                  <span aria-hidden="true" className="question-control">
                    {multi ? <QuestionGlyph name="check" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="widget-option-label">{option.label}</span>
                    {option.description ? (
                      <span className="widget-option-description">{option.description}</span>
                    ) : null}
                  </span>
                  <kbd aria-hidden="true" className="widget-option-key">
                    {widgetOptionLetter(index)}
                  </kbd>
                </ButtonPrimitive>
              );
            })}
            {widget.allowCustom ? (
              <label className="widget-option widget-custom" data-filled={custom.trim() ? "" : undefined}>
                <span aria-hidden="true" className="question-control question-control-pencil">
                  <QuestionGlyph name="pencil" />
                </span>
                <textarea
                  aria-label="Custom answer"
                  aria-keyshortcuts={customLetter.toLowerCase()}
                  autoComplete="off"
                  disabled={pending}
                  onChange={(event) => {
                    setCustom(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void submit(multi ? selectedValue : custom.trim());
                    }
                  }}
                  placeholder="Something else"
                  ref={customRef}
                  rows={1}
                  spellCheck={false}
                  value={custom}
                />
                <kbd aria-hidden="true" className="widget-option-key">
                  {customLetter}
                </kbd>
                {multi ? null : (
                  <ButtonPrimitive
                    aria-label="Send answer"
                    className="question-send-inline"
                    disabled={pending || !custom.trim()}
                    title="Send answer"
                    type="submit"
                  >
                    <QuestionGlyph name="send" />
                  </ButtonPrimitive>
                )}
              </label>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="question-error">
              {error}
            </p>
          ) : null}
          <div className="question-footer">
            <span className="question-hint">Or reply in chat</span>
            <ButtonPrimitive
              aria-label="Skip question"
              className="question-skip"
              disabled={pending}
              onClick={() => void dismiss()}
              title="Skip without answering"
              type="button"
            >
              Skip
            </ButtonPrimitive>
            {multi ? (
              <ButtonPrimitive className="widget-submit" disabled={pending || !selectedValue} type="submit">
                Send answer
              </ButtonPrimitive>
            ) : null}
          </div>
        </form>
      )}
    </QuestionFrame>
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
        <ButtonPrimitive
          className="permission-button permission-button-primary"
          disabled={!value.trim() || pending}
          type="submit"
        >
          Save securely
        </ButtonPrimitive>
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
        openComputerHandoff({ botId: message.senderBotId, messageId: message.id, reason: String(record(metadata.computerHandoff).reason ?? message.content) });
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
          <ButtonPrimitive
            className="h-8 rounded-lg px-2.5 font-medium text-foreground-secondary hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
            disabled={pending}
            onClick={() => void mutate("skip")}
            type="button"
          >
            Skip
          </ButtonPrimitive>
          <ButtonPrimitive
            className="h-8 rounded-lg bg-[#141414] px-2.5 font-medium text-white disabled:opacity-40 dark:bg-[#f0f0f0] dark:text-[#181818]"
            disabled={pending || !message.senderBotId}
            onClick={() => void mutate("start")}
            type="button"
          >
            {state === "active" ? "Return to computer" : "Take over"}
          </ButtonPrimitive>
        </div>
      )}
    </section>
  );
}

export function RichMessage({ message, bot }: { message: ChannelMessageView; bot?: BotView }) {
  const metadata = record(message.metadata);
  if (metadata.type === "presentation") return (
    <MessageRendererBoundary content={message.content}>
      <Suspense fallback={<MessageResponse>{message.content}</MessageResponse>}>
        <PresentationMessage value={metadata.presentation} fallback={message.content}/>
      </Suspense>
    </MessageRendererBoundary>
  );
  if (metadata.type === "bot-template" && metadata.template && typeof metadata.template === "object")
    return <SharedTemplateCard message={message} />;
  if (metadata.type === "external-draft") {
    try {
      return <ExternalDraftCard bot={bot} draft={parseExternalDraft(metadata.draft)} message={message} />;
    } catch {
      return null;
    }
  }
  if (metadata.type === "imessage-send" && metadata.imessage && typeof metadata.imessage === "object")
    return <IMessageSendCard message={message} />;
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
