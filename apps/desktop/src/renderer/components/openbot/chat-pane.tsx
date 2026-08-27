import type {
  ApprovalDecision,
  ApprovalView,
  BotView,
  ChannelMessageView,
  ChannelView,
  ClientSnapshot,
  InlineImageInput,
  RunItemView,
  RunView,
} from "@openbot/contracts";
import {
  Check,
  CircleAlert,
  Copy,
  Ellipsis,
  MessageCircle,
  Reply,
  Smile,
  Users,
} from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../client/openbot-api";
import { formatIdleGapTimestamp, shouldShowIdleGapTimestamp } from "../../lib/message-timestamps";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  ConversationTopDivider,
  ConversationViewportAnchor,
} from "../ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import { PromptInput } from "../ai-elements/prompt-input";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { BotAvatar } from "./avatar";
import { EmojiPanel, EmojiPicker, MoreEmojiIcon, QUICK_REACTIONS } from "./emoji-picker";
import { MessageImageGallery } from "./image-attachment";

type Mutate = <T>(operation: () => Promise<T>) => Promise<T>;

interface ChatPaneProps {
  channel: ChannelView;
  selectedBot?: BotView;
  messages: ChannelMessageView[];
  runs: RunView[];
  itemsByRun: ReadonlyMap<string, RunItemView[]>;
  approvalsByRun: ReadonlyMap<string, ApprovalView[]>;
  botById: ReadonlyMap<string, BotView>;
  activeRun?: RunView;
  runtime: ClientSnapshot["runtime"];
  mutate: Mutate;
  focusMessage: { messageId: string; nonce: number } | null;
}

const runGroupsEqual = <T,>(
  runs: RunView[],
  previous: ReadonlyMap<string, T[]>,
  next: ReadonlyMap<string, T[]>
) => runs.every((run) => previous.get(run.id) === next.get(run.id));

const chatPanePropsEqual = (previous: ChatPaneProps, next: ChatPaneProps) =>
  previous.channel === next.channel &&
  previous.selectedBot === next.selectedBot &&
  previous.messages === next.messages &&
  previous.runs === next.runs &&
  previous.botById === next.botById &&
  previous.activeRun === next.activeRun &&
  previous.runtime === next.runtime &&
  previous.mutate === next.mutate &&
  previous.focusMessage === next.focusMessage &&
  runGroupsEqual(next.runs, previous.itemsByRun, next.itemsByRun) &&
  runGroupsEqual(next.runs, previous.approvalsByRun, next.approvalsByRun);

type MessageGroupPosition = "single" | "first" | "middle" | "last";

const messagesShareGroup = (
  previous: ChannelMessageView | undefined,
  next: ChannelMessageView | undefined
) =>
  Boolean(
    previous &&
      next &&
      previous.sender === next.sender &&
      (previous.sender !== "agent" || previous.senderBotId === next.senderBotId) &&
      !shouldShowIdleGapTimestamp(previous.createdAt, next.createdAt)
  );

const getMessageGroupPosition = (
  messages: ChannelMessageView[],
  index: number
): MessageGroupPosition => {
  const groupedWithPrevious = messagesShareGroup(messages[index - 1], messages[index]);
  const groupedWithNext = messagesShareGroup(messages[index], messages[index + 1]);

  if (groupedWithPrevious && groupedWithNext) return "middle";
  if (groupedWithPrevious) return "last";
  if (groupedWithNext) return "first";
  return "single";
};

const messageMetadata = (message: ChannelMessageView): Record<string, unknown> =>
  message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};

const messageImages = (message: ChannelMessageView) => {
  const images = messageMetadata(message).images;
  if (!Array.isArray(images)) return [];
  return images.flatMap((image) => {
    if (!image || typeof image !== "object" || Array.isArray(image)) return [];
    const { url, alt } = image as Record<string, unknown>;
    if (typeof url !== "string" || !(url.startsWith("data:image/") || url.startsWith("https://"))) {
      return [];
    }
    return [{ url, ...(typeof alt === "string" ? { alt } : {}) }];
  });
};

const channelMessageAddress = (message: ChannelMessageView): string => {
  if (message.sender === "user") return `t${message.sequence}u`;
  const address = messageMetadata(message).address;
  return typeof address === "string" ? address : `t${message.sequence}s0`;
};

const getUserReaction = (message: ChannelMessageView): string | null => {
  const reaction = messageMetadata(message).userReaction;
  return typeof reaction === "string" ? reaction : null;
};

const replyPreviewFor = (
  message: ChannelMessageView,
  messagesById: ReadonlyMap<string, ChannelMessageView>,
  messagesByAddress: ReadonlyMap<string, ChannelMessageView>
): ChannelMessageView | { content: string; sender: ChannelMessageView["sender"] } | null => {
  const metadata = messageMetadata(message);
  const embedded = metadata.replyTo;
  if (embedded && typeof embedded === "object" && !Array.isArray(embedded)) {
    const reply = embedded as Record<string, unknown>;
    if (typeof reply.messageId === "string") {
      const target = messagesById.get(reply.messageId);
      if (target) return target;
    }
    if (typeof reply.content === "string") {
      return {
        content: reply.content,
        sender: reply.sender === "user" || reply.sender === "system" ? reply.sender : "agent",
      };
    }
  }
  const address =
    typeof metadata.reply_to === "string"
      ? metadata.reply_to
      : typeof metadata.replyTo === "string"
        ? metadata.replyTo
        : null;
  return address ? (messagesByAddress.get(address) ?? null) : null;
};

const copyMessage = (message: ChannelMessageView) => {
  if (!navigator.clipboard) return;
  void navigator.clipboard.writeText(message.content).catch(() => undefined);
};

const senderLabelFor = (
  message: Pick<ChannelMessageView, "sender" | "senderBotId">,
  botById: ReadonlyMap<string, BotView>
) => {
  if (message.sender === "user") return "You";
  if (message.sender === "system") return "System";
  return message.senderBotId ? (botById.get(message.senderBotId)?.name ?? "Bot") : "Bot";
};

const MessageRow = memo(function MessageRow({
  message,
  channel,
  senderBot,
  groupPosition,
  separatedFromPrevious,
  replyPreview,
  canInteract,
  onReply,
  onReact,
}: {
  message: ChannelMessageView;
  channel: ChannelView;
  senderBot?: BotView;
  groupPosition: MessageGroupPosition;
  separatedFromPrevious: boolean;
  replyPreview?: { content: string; senderLabel: string } | null;
  canInteract: boolean;
  onReply: (message: ChannelMessageView) => void;
  onReact: (message: ChannelMessageView, emoji: string) => void;
}) {
  const from =
    message.sender === "user" ? "user" : message.sender === "system" ? "system" : "assistant";
  const userReaction = getUserReaction(message);
  const images = messageImages(message);
  const reactions =
    message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata) &&
    Array.isArray((message.metadata as { reactions?: unknown }).reactions)
      ? (message.metadata as { reactions: unknown[] }).reactions.filter(
          (reaction): reaction is { botId: string; emoji: string } =>
            Boolean(reaction) &&
            typeof reaction === "object" &&
            typeof (reaction as { botId?: unknown }).botId === "string" &&
            typeof (reaction as { emoji?: unknown }).emoji === "string"
        )
      : [];
  const actions = (
    <MessageActions className="pointer-events-none shrink-0 opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100">
      <EmojiPicker
        compactFirst
        onSelect={(emoji) => onReact(message, emoji)}
        selectedEmoji={userReaction}
      >
        <button
          aria-label="React to message"
          className="flex size-6 items-center justify-center rounded-full hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          disabled={!canInteract}
          type="button"
        >
          <Smile className="size-[15px]" />
        </button>
      </EmojiPicker>
      <MessageAction
        className="size-6 rounded-full"
        disabled={!canInteract}
        onClick={() => onReply(message)}
        tooltip="Reply"
      >
        <Reply className="size-[15px]" />
      </MessageAction>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="More message actions"
            className="flex size-6 items-center justify-center rounded-full hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            type="button"
          >
            <Ellipsis className="size-[15px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={from === "user" ? "end" : "start"}
          className="w-[156px] min-w-0"
        >
          <DropdownMenuItem className="h-8 text-[13px]" onSelect={() => copyMessage(message)}>
            <Copy className="size-3.5" /> Copy
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </MessageActions>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Message
          className={`group/message${separatedFromPrevious ? " mt-3" : ""}`}
          data-message-address={channelMessageAddress(message)}
          data-message-id={message.id}
          from={from}
        >
          {message.sender === "agent" &&
            channel.kind !== "bot_dm" &&
            groupPosition !== "middle" &&
            groupPosition !== "last" && (
              <div className="flex items-center gap-2 px-1 pt-2 text-xs text-muted-foreground">
                <BotAvatar bot={senderBot} size="sm" />
                <span>{senderBot?.name ?? "Bot"}</span>
              </div>
            )}
          {replyPreview && (
            <div
              className={`flex max-w-[min(640px,78%)] items-center gap-1.5 px-2 pb-0.5 text-xs text-muted-foreground ${
                from === "user" ? "self-end" : "self-start"
              }`}
            >
              <Reply className="size-3 shrink-0" />
              <span className="shrink-0 font-medium">{replyPreview.senderLabel}</span>
              <span className="truncate">{replyPreview.content}</span>
            </div>
          )}
          <div
            className={`flex w-full max-w-full gap-2 ${
              images.length > 0 ? "items-end" : "items-center"
            } ${from === "user" ? "justify-end" : "justify-start"}`}
          >
            {from === "user" && actions}
            {images.length > 0 ? (
              <div
                className={`flex max-w-[min(680px,78%)] flex-col gap-1.5 ${
                  from === "user" ? "items-end" : "items-start"
                }`}
                data-message-bubble-id={message.id}
              >
                <MessageImageGallery images={images} />
                {message.content && (
                  <MessageContent className="max-w-full" from={from}>
                    <MessageResponse>{message.content}</MessageResponse>
                  </MessageContent>
                )}
              </div>
            ) : (
              <MessageContent data-message-bubble-id={message.id} from={from}>
                <MessageResponse>{message.content}</MessageResponse>
              </MessageContent>
            )}
            {from !== "user" && actions}
          </div>
          {(reactions.length > 0 || userReaction) && (
            <div className={`flex gap-1 px-1 ${from === "user" ? "self-end" : "self-start"}`}>
              {userReaction && (
                <button
                  aria-label={`Remove ${userReaction} reaction`}
                  className="rounded-full border border-[#cbdcff] bg-[#eaf1ff] px-2 py-0.5 text-xs shadow-sm dark:border-[#35517f] dark:bg-[#17243a]"
                  disabled={!canInteract}
                  onClick={() => onReact(message, userReaction)}
                  type="button"
                >
                  {userReaction}
                </button>
              )}
              {reactions.map((reaction) => (
                <span
                  className="rounded-full border bg-background px-2 py-0.5 text-xs shadow-sm"
                  key={`${reaction.botId}:${reaction.emoji}`}
                  title="Bot reaction"
                >
                  {reaction.emoji}
                </span>
              ))}
            </div>
          )}
        </Message>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-[246px]">
        {canInteract && (
          <>
            <div className="flex items-center gap-0.5 px-1 py-0.5">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  aria-label={`React with ${emoji}`}
                  className={`flex size-[30px] items-center justify-center rounded-lg text-[20px] hover:bg-accent ${
                    userReaction === emoji ? "bg-accent ring-1 ring-input" : ""
                  }`}
                  key={emoji}
                  onClick={() => {
                    onReact(message, emoji);
                  }}
                  type="button"
                >
                  {emoji}
                </button>
              ))}
              <ContextMenuSub>
                <ContextMenuSubTrigger
                  aria-label="Open emoji picker"
                  className="size-[30px] justify-center gap-0 p-0"
                >
                  <MoreEmojiIcon />
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-[296px] p-0">
                  <EmojiPanel
                    onSelect={(emoji) => {
                      onReact(message, emoji);
                    }}
                    selectedEmoji={userReaction}
                  />
                </ContextMenuSubContent>
              </ContextMenuSub>
            </div>
            <ContextMenuSeparator className="my-0.5" />
            <ContextMenuItem onSelect={() => onReply(message)}>
              <Reply className="size-4" /> Reply
            </ContextMenuItem>
          </>
        )}
        <ContextMenuItem onSelect={() => copyMessage(message)}>
          <Copy className="size-4" /> Copy
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalView;
  onResolve: (decision: ApprovalDecision) => Promise<void>;
}) {
  if (approval.status !== "pending") return null;
  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <CircleAlert className="size-4 text-amber-500" /> Approval required
      </div>
      <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
        {JSON.stringify(approval.details, null, 2)}
      </pre>
      <div className="flex gap-2">
        <Button onClick={() => void onResolve("accept")} size="sm">
          <Check className="size-3.5" /> Allow
        </Button>
        <Button onClick={() => void onResolve("decline")} size="sm" variant="outline">
          Decline
        </Button>
      </div>
    </div>
  );
}

const Activity = memo(function Activity({
  runs,
  approvalsByRun,
  mutate,
}: {
  runs: RunView[];
  approvalsByRun: ReadonlyMap<string, ApprovalView[]>;
  mutate: Mutate;
}) {
  const approvals = useMemo(
    () => runs.flatMap((run) => approvalsByRun.get(run.id) ?? []),
    [approvalsByRun, runs]
  );
  if (approvals.length === 0) return null;
  return (
    <div className="mt-3 w-full max-w-[640px] space-y-2">
      {approvals.map((approval) => (
        <ApprovalCard
          approval={approval}
          key={approval.id}
          onResolve={(decision) =>
            mutate(() => api.resolveApproval(approval.id, decision)).then(() => undefined)
          }
        />
      ))}
    </div>
  );
});

const BotThinkingIndicator = memo(function BotThinkingIndicator({ bot }: { bot?: BotView }) {
  return (
    <div
      aria-label={`${bot?.name ?? "Bot"} is thinking`}
      className="flex h-8 items-center gap-2 px-5"
      data-bot-thinking=""
      role="status"
    >
      <BotAvatar bot={bot} size="sm" />
      <span aria-hidden="true" className="flex items-center gap-[3px]">
        {[0, 1, 2].map((index) => (
          <span
            className="size-1 rounded-full bg-foreground-tertiary motion-safe:animate-bounce"
            key={index}
            style={{ animationDelay: `${index * 120}ms`, animationDuration: "900ms" }}
          />
        ))}
      </span>
    </div>
  );
});

export const ChatPane = memo(function ChatPane({
  channel,
  selectedBot,
  messages,
  runs,
  approvalsByRun,
  botById,
  activeRun,
  runtime,
  mutate,
  focusMessage,
}: ChatPaneProps) {
  const [now, setNow] = useState(() => new Date());
  const [replyTarget, setReplyTarget] = useState<{
    channelId: string;
    messageId: string;
  } | null>(null);
  const [pendingImageCount, setPendingImageCount] = useState(0);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message] as const)),
    [messages]
  );
  const messagesByAddress = useMemo(
    () => new Map(messages.map((message) => [channelMessageAddress(message), message] as const)),
    [messages]
  );
  const replyingTo =
    replyTarget?.channelId === channel.id
      ? (messagesById.get(replyTarget.messageId) ?? null)
      : null;
  useEffect(() => {
    if (!focusMessage || !messagesById.has(focusMessage.messageId)) return;
    const timer = window.setTimeout(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(focusMessage.messageId)}"]`
      );
      if (!row) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      if (!reduceMotion) {
        row.animate(
          [
            { filter: "brightness(1)", transform: "translateZ(0)" },
            { filter: "brightness(0.88)", transform: "translateZ(0)" },
            { filter: "brightness(1)", transform: "translateZ(0)" },
          ],
          { duration: 760, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
        );
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusMessage, messagesById]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const replyToMessage = useCallback(
    (message: ChannelMessageView) => {
      setReplyTarget({ channelId: channel.id, messageId: message.id });
    },
    [channel.id]
  );
  const reactToMessage = useCallback(
    (message: ChannelMessageView, emoji: string) => {
      void mutate(() => api.reactToMessage(message.id, emoji));
    },
    [mutate]
  );
  const submit = useCallback(
    (content: string, images: InlineImageInput[]) =>
      mutate(() =>
        channel.kind === "bot_dm" && selectedBot
          ? api.sendMessage(selectedBot.conversationId, content, images, replyingTo?.id)
          : api.sendChannelMessage(channel.id, content, images, replyingTo?.id)
      ),
    [channel.id, channel.kind, mutate, replyingTo?.id, selectedBot]
  );
  const stop = useCallback(
    () => (activeRun ? mutate(() => api.cancelRun(activeRun.id)) : Promise.resolve()),
    [activeRun, mutate]
  );
  const botCanQueue = selectedBot && ["provisioning", "active"].includes(selectedBot.status);
  const onboardingInProgress = Boolean(
    selectedBot && ["pending", "queued", "running"].includes(selectedBot.onboardingStatus)
  );
  const canSend =
    channel.kind !== "agent_dm" &&
    (channel.kind === "bot_dm" ? Boolean(botCanQueue) : runtime.agent === "ready");
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <Conversation>
        <ConversationTopDivider />
        <ConversationContent
          className={`max-w-none gap-1 px-1 pt-10 transition-[padding-bottom] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
            pendingImageCount > 0 ? "pb-24" : composerExpanded ? "pb-16" : "pb-6"
          }`}
        >
          {messages.length === 0 && onboardingInProgress ? (
            <>
              <div className="flex justify-center pb-3 pt-[26.5px]">
                <time
                  className="select-none text-xs tabular-nums text-muted-foreground"
                  dateTime={channel.createdAt}
                >
                  {formatIdleGapTimestamp(channel.createdAt, now)}
                </time>
              </div>
              <BotThinkingIndicator bot={selectedBot} />
            </>
          ) : messages.length === 0 ? (
            <ConversationEmptyState
              description={
                channel.kind === "group"
                  ? "One room, delivered to each bot in order."
                  : "Messages wake the same durable Pi session."
              }
              icon={
                channel.kind === "group" ? (
                  <Users className="size-8" />
                ) : (
                  <MessageCircle className="size-8" />
                )
              }
              title={channel.kind === "group" ? "Start the group" : "Start a conversation"}
            />
          ) : (
            messages.map((message, index) => (
              <Fragment key={message.id}>
                {shouldShowIdleGapTimestamp(messages[index - 1]?.createdAt, message.createdAt) && (
                  <div
                    className={`flex justify-center pb-3 ${index === 0 ? "pt-[26.5px]" : "pt-6"}`}
                  >
                    <time
                      className="select-none text-xs tabular-nums text-muted-foreground"
                      dateTime={message.createdAt}
                    >
                      {formatIdleGapTimestamp(message.createdAt, now)}
                    </time>
                  </div>
                )}
                <MessageRow
                  canInteract={canSend && message.sender !== "system"}
                  channel={channel}
                  groupPosition={getMessageGroupPosition(messages, index)}
                  message={message}
                  onReact={reactToMessage}
                  onReply={replyToMessage}
                  replyPreview={(() => {
                    const preview = replyPreviewFor(message, messagesById, messagesByAddress);
                    if (!preview) return null;
                    return {
                      content:
                        preview.content ||
                        ("senderBotId" in preview && messageImages(preview).length > 0
                          ? "Image"
                          : ""),
                      senderLabel: senderLabelFor(
                        "senderBotId" in preview ? preview : { ...preview, senderBotId: null },
                        botById
                      ),
                    };
                  })()}
                  separatedFromPrevious={
                    index > 0 &&
                    !messagesShareGroup(messages[index - 1], message) &&
                    !shouldShowIdleGapTimestamp(messages[index - 1]?.createdAt, message.createdAt)
                  }
                  senderBot={message.senderBotId ? botById.get(message.senderBotId) : undefined}
                />
              </Fragment>
            ))
          )}
          {activeRun && !(messages.length === 0 && onboardingInProgress) && (
            <BotThinkingIndicator bot={botById.get(activeRun.botId)} />
          )}
          <Activity approvalsByRun={approvalsByRun} mutate={mutate} runs={runs} />
        </ConversationContent>
        <ConversationViewportAnchor active={composerExpanded || pendingImageCount > 0} />
        <ConversationScrollButton conversationId={channel.id} messageCount={messages.length} />
      </Conversation>
      {channel.kind === "agent_dm" ? (
        <div className="mx-auto w-full max-w-[1040px] px-5 pb-4">
          <div className="rounded-full border bg-muted/50 px-4 py-3 text-center text-xs text-muted-foreground">
            This bot-to-bot chat is view-only.
          </div>
        </div>
      ) : onboardingInProgress ? null : (
        <PromptInput
          disabled={!canSend}
          key={channel.id}
          onCancelReply={() => setReplyTarget(null)}
          onExpandedChange={setComposerExpanded}
          onImagesChange={setPendingImageCount}
          onStop={activeRun ? stop : undefined}
          onSubmit={submit}
          placeholder={
            selectedBot?.status === "provisioning"
              ? `Message ${channel.name} — it will be queued`
              : runtime.agent !== "ready"
                ? channel.kind === "bot_dm"
                  ? `Message ${channel.name} — it will be queued`
                  : "Pi runtime is not ready"
                : `Message ${channel.name}`
          }
          reply={
            replyingTo
              ? {
                  id: replyingTo.id,
                  content:
                    replyingTo.content || (messageImages(replyingTo).length > 0 ? "Image" : ""),
                }
              : null
          }
          running={Boolean(activeRun)}
        />
      )}
    </div>
  );
}, chatPanePropsEqual);
