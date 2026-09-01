import type {
  ChannelMessageView,
  RichMessageSecretRequest as SecretRequest,
  RichMessageWidget as Widget,
  RichMessageWidgetOption as WidgetOption,
} from "@openbot/contracts";
import {
  parseRichMessageSecretRequest as secretFrom,
  parseRichMessageWidget as widgetFrom,
  resolvedWidgetAnswers,
  richMessageMetadata as record,
  secretRequestPlaceholder,
  toggleWidgetSelection,
  type RichMessageMetadata as RichMetadata,
  widgetOptionLetter,
  widgetOptionValue as optionValue,
  widgetResponseValue,
} from "@openbot/product-core/rich-messages";
import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../client/openbot-api";
import { cn } from "../../lib/cn";

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
  "rich-message-card flex w-full max-w-[520px] min-w-0 flex-col gap-2.5 overflow-hidden rounded-2xl bg-[#eeeeee] p-3 text-[13px] text-[#141414] dark:bg-[#262626] dark:text-[#f0f0f0]";
const secondaryText = "text-[#141414]/60 dark:text-[#f0f0f0]/60";
const optionGroupClass =
  "flex w-full min-w-0 flex-col overflow-hidden rounded-lg border-[0.5px] border-solid border-black/10 bg-[#e8e8e8] dark:border-white/10 dark:bg-white/[0.035]";
const optionRowClass =
  "flex h-auto w-full min-w-0 items-center justify-start gap-2 p-2 text-left outline-offset-[-2px] disabled:opacity-50";
const optionKeyClass =
  "inline-flex min-w-[18px] shrink-0 items-center justify-center rounded border-[0.5px] border-solid border-black/[0.05] bg-black/[0.045] px-1 py-px text-[11px] font-medium text-black/60 dark:border-white/[0.06] dark:bg-white/[0.07] dark:text-white/60";

function ResolvedWidget({ metadata, widget }: { metadata: RichMetadata; widget: Widget }) {
  const answer = String(metadata.respondedValue ?? "");
  const answers = resolvedWidgetAnswers(widget, answer);
  return (
    <section className={cardClass} data-rich-widget-state="resolved" role="group">
      <p className="m-0 min-w-0 text-[14px] font-medium leading-5">{widget.prompt}</p>
      <div aria-label="Your answer" className={optionGroupClass} role="group">
        {answers.map(({ value, label, optionIndex }) => {
          return (
            <div
              className="flex w-full min-w-0 items-center gap-2 border-t-[0.5px] border-black/10 p-2 first:border-t-0 dark:border-white/10"
              key={value}
            >
              {optionIndex !== null ? (
                <span className={cn(optionKeyClass, "opacity-40")}>
                  {widgetOptionLetter(optionIndex)}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 font-medium">{label}</span>
              <Check aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
            </div>
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
      className={cn(cardClass, "flex-row items-center gap-2")}
      data-rich-widget-state="dismissed"
      role="group"
    >
      <p className={cn("m-0 min-w-0 flex-1 font-medium leading-5", secondaryText)}>
        {widget.prompt}
      </p>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-black/[0.04] px-2 py-0.5 text-xs font-medium dark:bg-white/[0.04]",
          secondaryText
        )}
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> Dismissed
      </span>
    </section>
  );
}

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
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [custom, setCustom] = useState("");
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLFormElement>(null);
  const shortcutHandlerRef = useRef<RichWidgetShortcutHandler>(() => undefined);
  const titleId = useId();
  useEffect(() => setLocalMetadata(metadata), [metadata]);
  const settled =
    typeof localMetadata.respondedValue === "string" || localMetadata.widgetDismissed === true;
  const selectedValue = useMemo(
    () => widgetResponseValue(widget, selected, custom),
    [custom, selected, widget]
  );

  const submit = async (value: string) => {
    if (!value || pending || settled) return;
    const previous = localMetadata;
    setPending(true);
    setLocalMetadata({ ...previous, respondedValue: value });
    try {
      const result = await api.respondToWidget(message.id, value);
      if (!result.accepted) setLocalMetadata(previous);
      else setLocalMetadata(record(result.message.metadata));
    } catch {
      setLocalMetadata(previous);
    } finally {
      setPending(false);
    }
  };

  const dismiss = async () => {
    if (pending || settled) return;
    const previous = localMetadata;
    setPending(true);
    setLocalMetadata({ ...previous, widgetDismissed: true });
    try {
      const result = await api.dismissWidget(message.id);
      if (!result.accepted) setLocalMetadata(previous);
      else setLocalMetadata(record(result.message.metadata));
    } catch {
      setLocalMetadata(previous);
    } finally {
      setPending(false);
    }
  };

  const choose = (value: string) => {
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
      className={cardClass}
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
          className="grid size-5 shrink-0 place-items-center rounded-md hover:bg-black/[0.06] disabled:opacity-40 dark:hover:bg-white/[0.07]"
          disabled={pending}
          onClick={() => void dismiss()}
          title="Dismiss without answering"
          type="button"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className={optionGroupClass}>
        {widget.options.map((option, index) => {
          const value = optionValue(option);
          const active = selected.has(value);
          return (
            <button
              aria-keyshortcuts={widgetOptionLetter(index).toLowerCase()}
              aria-pressed={widget.multiSelect ? active : undefined}
              className={cn(
                optionRowClass,
                "border-t-[0.5px] border-black/10 first:border-t-0 hover:bg-black/[0.055] dark:border-white/10 dark:hover:bg-white/[0.055]",
                active && "bg-black/[0.105] dark:bg-white/[0.105]"
              )}
              disabled={pending}
              key={`${value}-${index}`}
              onClick={() => choose(value)}
              type="button"
            >
              <span className={optionKeyClass}>{widgetOptionLetter(index)}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{option.label}</span>
                {option.description ? (
                  <span className={cn("mt-0.5 block leading-4", secondaryText)}>
                    {option.description}
                  </span>
                ) : null}
              </span>
              {active ? <Check className="size-4 shrink-0" /> : null}
            </button>
          );
        })}
      </div>
      {widget.allowCustom ? (
        <div className="flex w-full min-w-0 items-start gap-2">
          <div className="flex min-h-8 min-w-0 flex-1 basis-0 items-stretch rounded-lg border border-black/15 bg-white transition-colors duration-150 focus-within:border-black/30 dark:border-white/15 dark:bg-black/20 dark:focus-within:border-white/30">
            <textarea
              aria-label="Custom answer"
              autoComplete="off"
              className="block min-w-0 flex-1 resize-none overflow-y-hidden border-0 bg-transparent px-2.5 py-[5px] font-inherit text-current outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
              disabled={pending}
              onChange={(event) => setCustom(event.currentTarget.value)}
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
              className="rich-message-submit h-8 shrink-0 rounded-lg bg-[#141414] px-2.5 font-medium text-white disabled:opacity-40 dark:bg-[#f0f0f0] dark:text-[#181818]"
              disabled={pending}
              type="submit"
            >
              Submit
            </button>
          ) : null}
        </div>
      ) : null}
      {widget.multiSelect && selectedValue ? (
        <div className="flex w-full justify-end">
          <button
            className="h-8 rounded-lg bg-[#141414] px-2.5 font-medium text-white disabled:opacity-40 dark:bg-[#f0f0f0] dark:text-[#181818]"
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
  const titleId = useId();
  useEffect(() => setProvided(metadata.secretProvided === true), [metadata.secretProvided]);
  if (provided) {
    return (
      <section aria-labelledby={titleId} className={cn(cardClass, "flex-row items-center gap-2")}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14px] font-medium" id={titleId}>
            {request.label}
          </span>
          <span className={cn("text-[14px]", secondaryText)}>Saved securely and kept private.</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-3 py-1 font-medium text-emerald-600 dark:text-emerald-400">
          <Check className="size-4" /> Saved
        </span>
      </section>
    );
  }
  return (
    <form
      aria-labelledby={titleId}
      className={cardClass}
      onSubmit={async (event) => {
        event.preventDefault();
        const secret = value;
        if (!secret.trim() || pending) return;
        setValue("");
        setPending(true);
        try {
          const result = await api.submitSecret(message.id, secret);
          if (result.accepted || record(result.message.metadata).secretProvided === true) {
            setProvided(true);
          }
        } catch {
          // The card intentionally stays open with an empty secure field so the
          // value is never retained in renderer state after a submit attempt.
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="flex min-w-0 flex-col">
        <div className="text-[14px] font-medium" id={titleId}>
          {request.label}
        </div>
        {request.description ? (
          <p className={cn("m-0 leading-5", secondaryText)}>{request.description}</p>
        ) : null}
      </div>
      <div className="flex w-full min-w-0 items-start gap-2">
        <input
          aria-labelledby={titleId}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-lg border border-black/15 bg-white px-2.5 py-1.5 font-inherit outline-none transition-colors duration-150 placeholder:text-black/35 focus:border-black/30 dark:border-white/15 dark:bg-black/20 dark:placeholder:text-white/35 dark:focus:border-white/30"
          disabled={pending}
          onChange={(event) => setValue(event.currentTarget.value)}
          placeholder={secretRequestPlaceholder(request.label)}
          spellCheck={false}
          type="password"
          value={value}
        />
        <button
          className="h-8 shrink-0 rounded-lg bg-[#141414] px-2.5 font-medium text-white disabled:opacity-35 dark:bg-[#f0f0f0] dark:text-[#181818]"
          disabled={!value.trim() || pending}
          type="submit"
        >
          Save securely
        </button>
      </div>
      <div className={cn("flex min-w-0 items-start gap-1 text-xs", secondaryText)}>
        <span className="mt-[3px] flex shrink-0">
          <ShieldCheck className="size-4" />
        </span>
        <span className="min-w-0">Stored securely, never shown to your Bot.</span>
      </div>
    </form>
  );
}

export function RichMessage({ message }: { message: ChannelMessageView }) {
  const metadata = record(message.metadata);
  if (metadata.type === "widget") {
    const widget = widgetFrom(metadata.widget);
    return widget ? <WidgetCard message={message} metadata={metadata} widget={widget} /> : null;
  }
  if (metadata.type === "secret-request") {
    const request = secretFrom(metadata.secretRequest ?? metadata.secret);
    return request ? <SecretCard message={message} metadata={metadata} request={request} /> : null;
  }
  return null;
}
