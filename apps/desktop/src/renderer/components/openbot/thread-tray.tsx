import type { AssetRef, BotView, ChannelMessageView } from "@openbot/contracts";
import {
  durableSendIsInFlight,
  durableSendMessage,
  durableSendRenderKey,
  durableSendStatusLabel,
  type DurableSendPayload,
  type DurableSendRecord,
  type DurableStagedAttachment,
} from "@openbot/product-core/durable-delivery";
import {
  messageDisplayProjection,
  messageRenderKey,
  threadReplyCountLabel,
} from "@openbot/product-core/messages";
import {
  formatOfflineDeliveryLabel,
  formatOfflineDeliveryTimestamp,
} from "@openbot/product-core/timestamps";
import { File, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../../client/openbot-api";
import { useVirtualWindow } from "../../hooks/use-virtual-window";
import {
  desktopSendTransportSnapshot,
  subscribeDesktopSendTransport,
} from "../../lib/durable-sends";
import type { MentionOption } from "../../lib/mentions";
import { PromptInput } from "../ai-elements/prompt-input";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { BotAvatar } from "./avatar";
import { MessageImageGallery } from "./image-attachment";

const MessageFileAttachments = lazy(() =>
  import("./file-attachment").then((module) => ({ default: module.MessageFileAttachments }))
);

const ThreadMessage = ({
  botById,
  delivery,
  message,
  onCancelSend,
  onDeleteSend,
  onResendSend,
}: {
  botById: ReadonlyMap<string, BotView>;
  delivery: DurableSendRecord | null;
  message: ChannelMessageView;
  onCancelSend: (nonce: string) => void;
  onDeleteSend: (nonce: string) => void;
  onResendSend: (nonce: string) => void;
}) => {
  const bot = message.senderBotId ? botById.get(message.senderBotId) : undefined;
  const from = message.sender === "user" ? "user" : "assistant";
  const pending = delivery ? durableSendIsInFlight(delivery) : false;
  const transportDown = useSyncExternalStore(
    subscribeDesktopSendTransport,
    desktopSendTransportSnapshot,
    desktopSendTransportSnapshot
  );
  const offlineTime =
    delivery?.queuedAtMs != null ? formatOfflineDeliveryTimestamp(delivery.queuedAtMs) : null;
  const display = messageDisplayProjection(message);
  const stagedImages = display.stagedAttachments.filter(
    (attachment) => attachment.kind === "image" && attachment.previewUri
  );
  const stagedFiles = display.stagedAttachments.filter(
    (attachment) => attachment.kind !== "image" || !attachment.previewUri
  );
  const images = [
    ...display.attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({ url: api.assetUrl(attachment), alt: attachment.alt })),
    ...stagedImages.map((attachment) => ({
      url: attachment.previewUri as string,
      alt: attachment.alt ?? attachment.fileName,
    })),
  ];
  const [retainedOfflineTime, setRetainedOfflineTime] = useState(offlineTime);
  useEffect(() => {
    if (offlineTime !== null) setRetainedOfflineTime(offlineTime);
  }, [offlineTime]);
  return (
    <div
      className={`thread-message-row flex items-end gap-2 ${
        from === "user" ? "justify-end" : "justify-start"
      }`}
      data-failed={delivery?.phase === "failed" || undefined}
      data-pending={pending || undefined}
      data-thread-message-id={message.id}
    >
      {from !== "user" && <BotAvatar bot={bot} size="sm" />}
      <div className={`max-w-[82%] ${from === "user" ? "items-end" : "items-start"}`}>
        {from !== "user" && (
          <div className="mb-1 px-1 text-[11px] text-muted-foreground">{bot?.name ?? "Bot"}</div>
        )}
        {images.length > 0 || display.files.length > 0 || stagedFiles.length > 0 ? (
          <div className={`flex flex-col gap-1.5 ${from === "user" ? "items-end" : "items-start"}`}>
            <MessageImageGallery images={images} />
            {display.files.length > 0 && (
              <Suspense fallback={null}>
                <MessageFileAttachments attachments={display.files} />
              </Suspense>
            )}
            {stagedFiles.map((attachment) => (
              <article
                className="flex h-[52px] w-[246px] max-w-full items-center gap-2 rounded-[12px] border border-black/10 bg-background px-3 dark:border-white/15"
                data-staged-attachment=""
                key={attachment.stagingId}
              >
                <File className="size-[17px] shrink-0 text-foreground-secondary" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {attachment.fileName}
                </span>
              </article>
            ))}
            {display.displayContent && (
              <MessageContent from={from}>
                <MessageResponse>{display.displayContent}</MessageResponse>
              </MessageContent>
            )}
          </div>
        ) : (
          <MessageContent from={from}>
            <MessageResponse>{display.displayContent}</MessageResponse>
          </MessageContent>
        )}
        {delivery?.phase === "queued" ? (
          <div
            className="mt-1 flex items-center justify-end gap-1 text-[11px] leading-4 text-muted-foreground"
            role="status"
          >
            <span>{durableSendStatusLabel(delivery.phase, transportDown)}</span>
            <button onClick={() => onCancelSend(delivery.nonce)} type="button">
              Cancel
            </button>
          </div>
        ) : delivery?.phase === "failed" ? (
          <div
            aria-label="Failed message actions"
            className="mt-1 flex items-center justify-end gap-1 text-[11px] leading-4"
            role="group"
          >
            <span className="font-medium text-destructive" role="status">
              {durableSendStatusLabel(delivery.phase)}
            </span>
            <button onClick={() => onResendSend(delivery.nonce)} type="button">
              Resend
            </button>
            <button onClick={() => onDeleteSend(delivery.nonce)} type="button">
              Delete
            </button>
          </div>
        ) : (delivery?.phase === "accepted-awaiting-echo" && offlineTime) ||
          (!delivery && retainedOfflineTime) ? (
          <div
            aria-hidden={!delivery || undefined}
            className="sent-while-offline-notice text-[11px] leading-4 text-muted-foreground"
            data-cleared={!delivery || undefined}
            role="status"
          >
            {delivery?.queuedAtMs != null
              ? formatOfflineDeliveryLabel(delivery.queuedAtMs)
              : `Sent while offline · ${retainedOfflineTime}`}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export function ThreadTray({
  botById,
  mentionOptions,
  open,
  replies,
  root,
  focusMessageId,
  deliveries,
  recoveries,
  onClose,
  onCancelSend,
  onDeleteSend,
  onResendSend,
  onAcknowledgeRecovery,
  onSubmit,
  onStage,
  onDiscardStages,
}: {
  botById: ReadonlyMap<string, BotView>;
  mentionOptions: readonly MentionOption[];
  open: boolean;
  replies: readonly ChannelMessageView[];
  root: ChannelMessageView;
  focusMessageId?: string | null;
  deliveries: readonly DurableSendRecord[];
  recoveries: readonly DurableSendRecord[];
  onClose: () => void;
  onCancelSend: (nonce: string) => Promise<DurableSendPayload | null>;
  onDeleteSend: (nonce: string) => Promise<unknown>;
  onResendSend: (nonce: string) => Promise<unknown>;
  onAcknowledgeRecovery: (nonce: string) => Promise<void>;
  onStage: (file: Blob, fileName?: string) => Promise<DurableStagedAttachment>;
  onDiscardStages?: (attachments: readonly DurableStagedAttachment[]) => Promise<void>;
  onSubmit: (
    value: string,
    attachments: AssetRef[],
    options?: { richText?: string; stagedAttachments?: DurableStagedAttachment[] }
  ) => Promise<unknown> | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [composerRecovery, setComposerRecovery] = useState<{
    id: string;
    payload: DurableSendPayload;
    durable?: boolean;
  } | null>(null);
  const messages = useMemo(() => [root, ...replies], [replies, root]);
  const deliveryByMessageId = useMemo(
    () =>
      new Map(deliveries.map((delivery) => [durableSendMessage(delivery).id, delivery] as const)),
    [deliveries]
  );
  const estimateSize = useCallback((index: number) => (index === 0 ? 128 : 76), []);
  const getKey = useCallback(
    (index: number) => {
      const message = messages[index];
      if (!message) return `missing:${index}`;
      const delivery = deliveryByMessageId.get(message.id);
      return delivery ? durableSendRenderKey(delivery) : messageRenderKey(message);
    },
    [deliveryByMessageId, messages]
  );
  const cancelSend = useCallback(
    async (nonce: string) => {
      const payload = await onCancelSend(nonce);
      if (payload) setComposerRecovery({ id: `${nonce}:${Date.now()}`, payload });
    },
    [onCancelSend]
  );
  useEffect(() => {
    if (composerRecovery) return;
    const messageIds = new Set(messages.map((message) => message.id));
    const recovery = recoveries.find(
      (record) =>
        record.payload.isFork === true &&
        Boolean(record.payload.replyToMessageId) &&
        messageIds.has(record.payload.replyToMessageId as string)
    );
    if (!recovery) return;
    setComposerRecovery({ id: recovery.nonce, payload: recovery.payload, durable: true });
  }, [composerRecovery, messages, recoveries]);
  const { measureElement, scrollToIndex, totalSize, virtualItems } = useVirtualWindow({
    count: messages.length,
    estimateSize,
    getKey,
    initialViewportSize: 600,
    maxItems: 70,
    overscan: 500,
    scrollRef,
  });
  useEffect(() => {
    if (!open || !focusMessageId) return;
    const index = messages.findIndex((message) => message.id === focusMessageId);
    if (index < 0) return;
    scrollToIndex(index, { align: "center" });
    const timer = window.setTimeout(() => {
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[data-thread-message-id="${CSS.escape(focusMessageId)}"]`
      );
      row?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusMessageId, messages, open, scrollToIndex]);
  return (
    <div
      aria-hidden={!open}
      className={`absolute inset-0 z-40 transition-colors duration-300 motion-reduce:duration-120 ${
        open ? "bg-black/15" : "pointer-events-none bg-transparent"
      }`}
      data-thread-overlay=""
      inert={!open}
    >
      <button
        aria-label="Close thread"
        className="absolute inset-0"
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label="Thread"
        className={`absolute inset-y-2 right-2 flex w-[min(430px,calc(100%-16px))] flex-col overflow-hidden rounded-[18px] border-[0.5px] border-border bg-background shadow-[0_20px_60px_rgba(0,0,0,0.24)] transition-[transform,opacity] duration-300 ease-[linear(0,0.002,0.01_2.4%,0.04_5.2%,0.14_10.8%,0.32_18.8%,0.56_28.8%,0.74_39.4%,0.87_52.4%,0.95_68.8%,0.99_84.8%,1)] motion-reduce:duration-120 motion-reduce:ease-in-out ${
          open ? "translate-x-0 opacity-100" : "translate-x-5 opacity-0"
        }`}
        data-thread-tray=""
      >
        <header className="flex h-12 shrink-0 items-center border-b px-4">
          <h2 className="text-sm font-semibold">Thread</h2>
          <button
            aria-label="Close thread"
            className="ml-auto grid size-7 place-items-center rounded-full hover:bg-accent"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" ref={scrollRef} role="list">
          <div className="relative w-full" style={{ height: totalSize }}>
            {virtualItems.map((virtualItem) => {
              const message = messages[virtualItem.index];
              if (!message) return null;
              return (
                <div
                  aria-posinset={virtualItem.index + 1}
                  aria-setsize={messages.length}
                  className="absolute inset-x-0 top-0 pb-3"
                  data-virtual-thread-index={virtualItem.index}
                  key={virtualItem.key}
                  ref={(node) => measureElement(virtualItem.index, virtualItem.key, node)}
                  role="listitem"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <ThreadMessage
                    botById={botById}
                    delivery={deliveryByMessageId.get(message.id) ?? null}
                    message={message}
                    onCancelSend={(nonce) => void cancelSend(nonce)}
                    onDeleteSend={(nonce) => void onDeleteSend(nonce)}
                    onResendSend={(nonce) => void onResendSend(nonce)}
                  />
                  {virtualItem.index === 0 && (
                    <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{threadReplyCountLabel(replies.length, false)}</span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="shrink-0 border-t pt-3">
          <PromptInput
            key={root.id}
            mentionOptions={mentionOptions}
            recovery={composerRecovery}
            onRecoveryApplied={() =>
              setComposerRecovery((current) => (current?.durable ? current : null))
            }
            onRecoveryConsumed={async (nonce) => {
              await onAcknowledgeRecovery(nonce);
              setComposerRecovery((current) => (current?.id === nonce ? null : current));
            }}
            onSubmit={onSubmit}
            onStage={onStage}
            onDiscardStages={onDiscardStages}
            placeholder="Reply in thread"
          />
        </div>
      </aside>
    </div>
  );
}
