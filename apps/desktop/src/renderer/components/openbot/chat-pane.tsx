import type {
  ApprovalDecision,
  ApprovalView,
  AssetRef,
  BotView,
  ChannelMessageView,
  ChannelView,
  ClientSnapshot,
  RunItemView,
  RunView,
  SubagentActivityView,
} from "@openbot/contracts";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  Ellipsis,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Reply,
  Smile,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../client/openbot-api";
import { a2aProjectionFor, collapseA2ATimeline } from "../../lib/a2a-events";
import {
  BOT_TEMPLATE_REQUEST,
  type BotTemplateRecord,
  botTemplateFor,
  createBotTemplateDraft,
} from "../../lib/bot-template";
import {
  channelNameChangedEventFor,
  routineChangedActionLabel,
  routineChangedEventFor,
} from "../../lib/channel-events";
import { cn } from "../../lib/cn";
import { type MentionOption, mentionHandleFor } from "../../lib/mentions";
import { formatIdleGapTimestamp, shouldShowIdleGapTimestamp } from "../../lib/message-timestamps";
import { conversationApprovals } from "../../lib/subagent-activity";
import { deriveThreads, isBranchedMessage } from "../../lib/threads";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationInitialBottom,
  ConversationNewMessageBottom,
  ConversationScrollButton,
  ConversationTopDivider,
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
import {
  BotTemplateCard,
  BotTemplateDetailsDialog,
  TemplateAudienceQuestion,
  useBotTemplateRecord,
} from "./bot-template-share";
import { EmojiPanel, EmojiPicker, MoreEmojiIcon, QUICK_REACTIONS } from "./emoji-picker";
import { downloadAttachments, MessageFileAttachments } from "./file-attachment";
import { MessageImageGallery } from "./image-attachment";
import { ThreadTray } from "./thread-tray";

type Mutate = <T>(operation: () => Promise<T>) => Promise<T>;

interface ChatPaneProps {
  agentNameById: ReadonlyMap<string, string>;
  channel: ChannelView;
  selectedBot?: BotView;
  messages: ChannelMessageView[];
  runs: RunView[];
  subagents: SubagentActivityView[];
  itemsByRun: ReadonlyMap<string, RunItemView[]>;
  approvalsByRun: ReadonlyMap<string, ApprovalView[]>;
  botById: ReadonlyMap<string, BotView>;
  activeRun?: RunView;
  runtime: ClientSnapshot["runtime"];
  mutate: Mutate;
  focusMessage: { messageId: string; nonce: number } | null;
  onCloseViewOnly?: () => void;
  onOpenA2A?: (peerId: string, trigger: HTMLButtonElement) => void;
  onOpenRoutine?: (routineId: string) => void;
  templateShareRequest?: { botId: string; nonce: number } | null;
}

const runGroupsEqual = <T,>(
  runs: RunView[],
  previous: ReadonlyMap<string, T[]>,
  next: ReadonlyMap<string, T[]>
) => runs.every((run) => previous.get(run.id) === next.get(run.id));

const subagentApprovalGroupsEqual = (
  subagents: SubagentActivityView[],
  previous: ReadonlyMap<string, ApprovalView[]>,
  next: ReadonlyMap<string, ApprovalView[]>
) =>
  subagents.every(
    (subagent) =>
      !subagent.currentRunId ||
      previous.get(subagent.currentRunId) === next.get(subagent.currentRunId)
  );

const chatPanePropsEqual = (previous: ChatPaneProps, next: ChatPaneProps) =>
  previous.channel === next.channel &&
  previous.agentNameById === next.agentNameById &&
  previous.selectedBot === next.selectedBot &&
  previous.messages === next.messages &&
  previous.runs === next.runs &&
  previous.subagents === next.subagents &&
  previous.botById === next.botById &&
  previous.activeRun === next.activeRun &&
  previous.runtime === next.runtime &&
  previous.mutate === next.mutate &&
  previous.focusMessage === next.focusMessage &&
  previous.onCloseViewOnly === next.onCloseViewOnly &&
  previous.onOpenA2A === next.onOpenA2A &&
  previous.onOpenRoutine === next.onOpenRoutine &&
  previous.templateShareRequest === next.templateShareRequest &&
  runGroupsEqual(next.runs, previous.itemsByRun, next.itemsByRun) &&
  runGroupsEqual(next.runs, previous.approvalsByRun, next.approvalsByRun) &&
  subagentApprovalGroupsEqual(next.subagents, previous.approvalsByRun, next.approvalsByRun);

type MessageGroupPosition = "single" | "first" | "middle" | "last";
type ThinkingPhase = "hidden" | "visible" | "exiting";

const THINKING_EXIT_MS = 140;

interface OptimisticMessage {
  localId: string;
  message: ChannelMessageView;
  pending: boolean;
  serverMessageId: string | null;
}

const messagesShareGroup = (
  previous: ChannelMessageView | undefined,
  next: ChannelMessageView | undefined
) =>
  Boolean(
    previous &&
      next &&
      !a2aProjectionFor(previous) &&
      !a2aProjectionFor(next) &&
      !channelNameChangedEventFor(previous) &&
      !channelNameChangedEventFor(next) &&
      !routineChangedEventFor(previous) &&
      !routineChangedEventFor(next) &&
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

const appendThinkingIndicatorToGroup = (
  position: MessageGroupPosition,
  seamedToThinkingIndicator: boolean
): MessageGroupPosition => {
  if (!seamedToThinkingIndicator) return position;
  if (position === "single") return "first";
  if (position === "last") return "middle";
  return position;
};

const useThinkingPresence = (active: boolean): ThinkingPhase => {
  const [phase, setPhase] = useState<ThinkingPhase>(active ? "visible" : "hidden");

  useEffect(() => {
    if (active) {
      setPhase("visible");
      return;
    }
    setPhase((current) => (current === "visible" ? "exiting" : current));
  }, [active]);

  useEffect(() => {
    if (phase !== "exiting") return;
    const timer = window.setTimeout(() => {
      setPhase((current) => (current === "exiting" ? "hidden" : current));
    }, THINKING_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return active ? "visible" : phase;
};

const messageMetadata = (message: ChannelMessageView): Record<string, unknown> =>
  message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};

const messageAttachments = (message: ChannelMessageView): AssetRef[] => {
  const metadata = messageMetadata(message);
  const candidates = [
    ...(Array.isArray(metadata.attachments) ? metadata.attachments : []),
    ...(metadata.attachment ? [metadata.attachment] : []),
  ];
  return candidates.filter(
    (candidate): candidate is AssetRef =>
      Boolean(candidate) &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      typeof (candidate as { assetId?: unknown }).assetId === "string" &&
      /^[a-f0-9]{64}$/.test((candidate as { assetId: string }).assetId) &&
      typeof (candidate as { fileName?: unknown }).fileName === "string"
  );
};

const messageImages = (message: ChannelMessageView) =>
  messageAttachments(message)
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => ({
      url: api.assetUrl(attachment),
      alt: attachment.alt ?? attachment.fileName,
    }));

const channelMessageAddress = (message: ChannelMessageView): string => {
  if (message.sender === "user") return `t${message.sequence}u`;
  const address = messageMetadata(message).address;
  return typeof address === "string" ? address : `t${message.sequence}a0`;
};

const getUserReactions = (message: ChannelMessageView): string[] => {
  const metadata = messageMetadata(message);
  if (!Array.isArray(metadata.reactions)) return [];
  return [
    ...new Set(
      metadata.reactions.flatMap((reaction) => {
        if (!reaction || typeof reaction !== "object" || Array.isArray(reaction)) return [];
        const candidate = reaction as Record<string, unknown>;
        return candidate.by === "me" && typeof candidate.emoji === "string"
          ? [candidate.emoji]
          : [];
      })
    ),
  ];
};

const replyPreviewFor = (
  message: ChannelMessageView,
  messagesById: ReadonlyMap<string, ChannelMessageView>,
  messagesByAddress: ReadonlyMap<string, ChannelMessageView>
): ChannelMessageView | { content: string; sender: ChannelMessageView["sender"] } | null => {
  const metadata = messageMetadata(message);
  if (typeof metadata.replyTo === "string") {
    const target = messagesById.get(metadata.replyTo);
    if (target) return target;
  }
  const address = typeof metadata.reply_to === "string" ? metadata.reply_to : null;
  return address ? (messagesByAddress.get(address) ?? null) : null;
};

const copyMessage = (message: ChannelMessageView) => {
  if (!navigator.clipboard) return;
  void navigator.clipboard.writeText(message.content).catch(() => undefined);
};

const copyRequestId = (message: ChannelMessageView) => {
  if (!navigator.clipboard) return;
  void navigator.clipboard.writeText(message.id).catch(() => undefined);
};

const senderLabelFor = (
  message: Pick<ChannelMessageView, "sender" | "senderBotId"> & {
    metadata?: unknown;
  },
  botById: ReadonlyMap<string, BotView>
) => {
  if (
    message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata)
  ) {
    const metadata = message.metadata as Record<string, unknown>;
    const direction = metadata.fromAgent ? "incoming" : metadata.toAgent ? "outgoing" : null;
    const peer = direction === "incoming" ? metadata.fromAgent : metadata.toAgent;
    if (peer && typeof peer === "object" && !Array.isArray(peer)) {
      const peerName = (peer as Record<string, unknown>).name;
      if (typeof peerName === "string") return peerName;
    }
  }
  if (message.sender === "user") return "You";
  if (message.sender === "system") return "System";
  return message.senderBotId ? (botById.get(message.senderBotId)?.name ?? "Bot") : "Bot";
};

const MessageRow = memo(function MessageRow({
  message,
  channel,
  senderBot,
  senderName,
  groupPosition,
  separatedFromPrevious,
  replyPreview,
  canInteract,
  onReply,
  onReact,
  onOpenThread,
  onOpenRoutine,
  threadReplyCount,
  animateEntrance,
  pending,
}: {
  message: ChannelMessageView;
  channel: ChannelView;
  senderBot?: BotView;
  senderName?: string;
  groupPosition: MessageGroupPosition;
  separatedFromPrevious: boolean;
  replyPreview?: { content: string; senderLabel: string } | null;
  canInteract: boolean;
  onReply: (message: ChannelMessageView) => void;
  onReact: (message: ChannelMessageView, emoji: string) => void;
  onOpenThread: (message: ChannelMessageView) => void;
  onOpenRoutine?: (routineId: string) => void;
  threadReplyCount: number;
  animateEntrance: boolean;
  pending: boolean;
}) {
  const [entranceActive, setEntranceActive] = useState(animateEntrance);
  const channelEvent = channelNameChangedEventFor(message);
  const routineEvent = routineChangedEventFor(message);
  const from =
    message.sender === "user" ? "user" : message.sender === "system" ? "system" : "assistant";
  const hasAgentGutter = message.sender === "agent" && channel.kind !== "bot_dm";
  const showAgentAvatar =
    hasAgentGutter && (groupPosition === "single" || groupPosition === "last");
  const a2aProjection = channel.kind === "bot_dm" ? a2aProjectionFor(message) : null;
  const userReactions = getUserReactions(message);
  const userReactionSet = new Set(userReactions);
  const attachments = messageAttachments(message);
  const images = messageImages(message);
  const fileAttachments = attachments.filter((attachment) => attachment.kind !== "image");
  const displayContent = messageMetadata(message).type === "attachment" ? "" : message.content;
  const reactions =
    message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata) &&
    Array.isArray((message.metadata as { reactions?: unknown }).reactions)
      ? (message.metadata as { reactions: unknown[] }).reactions.filter(
          (reaction): reaction is { by: string; emoji: string } =>
            Boolean(reaction) &&
            typeof reaction === "object" &&
            typeof (reaction as { by?: unknown }).by === "string" &&
            typeof (reaction as { emoji?: unknown }).emoji === "string"
        )
      : [];
  const reactionPills = Array.from(
    reactions
      .map((reaction) => reaction.emoji)
      .reduce((pills, emoji) => {
        const pill = pills.get(emoji);
        if (pill) pill.count += 1;
        else pills.set(emoji, { emoji, count: 1 });
        return pills;
      }, new Map<string, { emoji: string; count: number }>())
      .values()
  );
  const previousReactionKeys = useRef<ReadonlySet<string> | null>(null);
  const newReactionKeys = new Set(
    previousReactionKeys.current
      ? reactionPills
          .filter(({ emoji }) => !previousReactionKeys.current?.has(emoji))
          .map(({ emoji }) => emoji)
      : []
  );
  useEffect(() => {
    previousReactionKeys.current = new Set(reactionPills.map(({ emoji }) => emoji));
  }, [reactionPills]);
  if (channelEvent) {
    return (
      <div
        className={`flex justify-center px-5 pb-3 pt-2 text-xs leading-5 text-muted-foreground${
          separatedFromPrevious ? " mt-3" : ""
        }`}
        data-channel-event="name-changed"
        data-message-id={message.id}
      >
        Renamed to {channelEvent.to}
      </div>
    );
  }
  if (routineEvent) {
    return (
      <div
        className={`flex min-h-8 items-center justify-center gap-1 px-5 pb-3 pt-2 text-[12px] leading-5 text-muted-foreground${
          separatedFromPrevious ? " mt-3" : ""
        }`}
        data-channel-event="automation-changed"
        data-message-id={message.id}
      >
        <span>{routineChangedActionLabel(routineEvent.action)}</span>
        <button
          aria-label={`Open routine ${routineEvent.automationName}`}
          className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full px-1.5 outline-none transition-colors hover:bg-[#f1f1f1] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/35 dark:hover:bg-[#252525]"
          data-routine-event-link=""
          onClick={() => onOpenRoutine?.(routineEvent.automationId)}
          title={routineEvent.automationName}
          type="button"
        >
          <Clock3 className="size-3 shrink-0" strokeWidth={1.7} />
          <span className="max-w-[240px] truncate">{routineEvent.automationName}</span>
        </button>
      </div>
    );
  }
  const actions = (
    <MessageActions
      className={`pointer-events-none shrink-0 opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 ${
        from === "user" ? "flex-row-reverse" : ""
      }`}
    >
      <EmojiPicker
        compactFirst
        onSelect={(emoji) => onReact(message, emoji)}
        selectedEmojis={userReactionSet}
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
          {from === "user" && (
            <DropdownMenuItem className="h-8 text-[13px]" onSelect={() => copyRequestId(message)}>
              <Copy className="size-3.5" /> Copy request ID
            </DropdownMenuItem>
          )}
          {attachments.length > 1 && (
            <DropdownMenuItem
              className="h-8 text-[13px]"
              onSelect={() => void downloadAttachments(attachments)}
            >
              <Download className="size-3.5" /> Download all
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </MessageActions>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Message
          className={`group/message${separatedFromPrevious ? " mt-3" : ""}`}
          data-enter={entranceActive ? "new" : undefined}
          data-message-address={channelMessageAddress(message)}
          data-message-id={message.id}
          data-pending={pending || undefined}
          from={from}
          onAnimationEnd={(event) => {
            if (
              event.animationName === "message-row-enter" ||
              event.animationName === "message-row-enter-reduced"
            ) {
              setEntranceActive(false);
            }
          }}
        >
          {a2aProjection && (
            <div className="flex items-center gap-1.5 px-1 pt-2 text-xs font-medium text-muted-foreground">
              <MessageCircle className="size-3.5" />
              <span>
                {a2aProjection.direction === "incoming" ? "Message from" : "Messaged"}{" "}
                {a2aProjection.peerName ?? (senderBot?.name || "another agent")}
              </span>
            </div>
          )}
          {message.sender === "agent" &&
            channel.kind !== "bot_dm" &&
            groupPosition !== "middle" &&
            groupPosition !== "last" && (
              <div
                className="pl-[46px] pt-2 text-xs leading-5 text-muted-foreground"
                data-message-agent-name=""
              >
                <span>{senderName ?? senderBot?.name ?? "Bot"}</span>
              </div>
            )}
          {replyPreview && (
            <div
              className={`flex max-w-[min(88%,640px,calc(100%-82px))] items-center gap-1.5 px-2 pb-0.5 text-xs text-muted-foreground ${
                from === "user" ? "self-end" : "self-start"
              }`}
            >
              <Reply className="size-3 shrink-0" />
              <span className="shrink-0 font-medium">{replyPreview.senderLabel}</span>
              <span className="truncate">{replyPreview.content}</span>
            </div>
          )}
          <div
            className={`flex w-full max-w-full ${hasAgentGutter ? "gap-[5px]" : "gap-2"} ${
              images.length > 0 || fileAttachments.length > 0 ? "items-end" : "items-center"
            } ${from === "user" ? "justify-end" : "justify-start"}`}
          >
            {from === "user" && actions}
            {hasAgentGutter && (
              <div
                className="flex w-6 shrink-0 self-stretch items-end justify-center"
                data-message-agent-gutter=""
              >
                {showAgentAvatar && <BotAvatar bot={senderBot} size="sm" />}
              </div>
            )}
            {images.length > 0 || fileAttachments.length > 0 ? (
              <div
                className={`flex max-w-[min(88%,640px,calc(100%-82px))] flex-col gap-1.5 ${
                  from === "user" ? "items-end" : "items-start"
                }`}
                data-message-bubble-id={message.id}
              >
                <MessageImageGallery images={images} />
                <MessageFileAttachments attachments={fileAttachments} />
                {displayContent && (
                  <MessageContent
                    className="max-w-full"
                    data-group-position={groupPosition}
                    from={from}
                  >
                    <MessageResponse>{displayContent}</MessageResponse>
                  </MessageContent>
                )}
              </div>
            ) : (
              <MessageContent
                data-group-position={groupPosition}
                data-message-bubble-id={message.id}
                from={from}
              >
                <MessageResponse>{message.content}</MessageResponse>
              </MessageContent>
            )}
            {from !== "user" && actions}
          </div>
          {(reactions.length > 0 || userReactions.length > 0) && (
            <div
              className={`relative -mt-2 flex flex-row flex-wrap gap-1 ${
                from === "user" ? "ml-auto mr-2.5 self-end justify-end" : "ml-2.5 self-start"
              }`}
            >
              {reactionPills.map(({ emoji, count }) => {
                const selected = userReactionSet.has(emoji);
                return (
                  <button
                    aria-label={`${selected ? "Remove" : "Add"} ${emoji} reaction`}
                    aria-pressed={selected}
                    className={`inline-flex h-[22px] origin-center items-center gap-[3px] rounded-full border-0 py-0 pl-[7px] pr-2 text-xs leading-4 tabular-nums text-[#666] shadow-[0_0_0_2px_#fcfcfc] transition-[transform,background-color] duration-[120ms] active:scale-95 disabled:cursor-default dark:text-[rgba(240,240,240,0.74)] dark:shadow-[0_0_0_2px_#070707] ${
                      newReactionKeys.has(emoji) ? "reaction-pill-enter" : ""
                    } ${
                      selected
                        ? "bg-[#e5f0ff] hover:bg-[#d9eaff] dark:bg-[#1a2e55] dark:hover:bg-[#1e3b69]"
                        : "bg-[#f3f3f3] hover:bg-[#ececec] dark:bg-[#202020] dark:hover:bg-[#292929]"
                    }`}
                    disabled={!canInteract}
                    key={emoji}
                    onClick={() => onReact(message, emoji)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="reaction-emoji text-[14px] leading-none text-foreground"
                    >
                      {emoji}
                    </span>
                    {count > 1 && <span>{count}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {threadReplyCount > 0 && (
            <button
              className={`mt-0.5 inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground ${
                from === "user" ? "self-end" : "self-start"
              }`}
              data-thread-summary-id={message.id}
              onClick={() => onOpenThread(message)}
              type="button"
            >
              <MessageCircle className="size-3.5" />
              {threadReplyCount} {threadReplyCount === 1 ? "reply" : "replies"}
            </button>
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
                    userReactionSet.has(emoji) ? "bg-accent ring-1 ring-input" : ""
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
                    selectedEmojis={userReactionSet}
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
        {from === "user" && (
          <ContextMenuItem onSelect={() => copyRequestId(message)}>
            <Copy className="size-4" /> Copy request ID
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

const approvalCardClass =
  "flex w-full min-w-0 flex-col gap-3 rounded-2xl bg-[#eeeeee] p-3 text-[13px] text-[#141414] dark:bg-[#262626] dark:text-[#f0f0f0]";
const approvalContentClass = "flex w-full min-w-0 flex-col items-start gap-1";
const approvalTitleClass =
  "min-w-0 flex-1 text-[14px] font-medium leading-[22px] text-[#141414] dark:text-[#f0f0f0]";
const approvalSecondaryTextClass = "text-[#141414]/[0.74] dark:text-[#f0f0f0]/[0.74]";
const approvalButtonClass = "h-8 rounded-lg px-2.5 py-0 text-[14px] leading-[22px] shadow-none";
const approvalPrimaryButtonClass = cn(
  approvalButtonClass,
  "bg-[#141414] text-[#fcfcfc] hover:bg-[#141414]/[0.74] dark:bg-[#f0f0f0] dark:text-[#181818] dark:hover:bg-[#f0f0f0]/[0.74]"
);
const approvalSecondaryButtonClass = cn(
  approvalButtonClass,
  "border-[#141414]/[0.08] bg-[#141414]/[0.04] text-[#141414] hover:bg-[#141414]/[0.14] hover:text-[#141414] dark:border-[#f0f0f0]/[0.08] dark:bg-[#f0f0f0]/[0.04] dark:text-[#f0f0f0] dark:hover:bg-[#f0f0f0]/[0.14] dark:hover:text-[#f0f0f0]"
);

const isLocalApproval = (approval: ApprovalView) =>
  Boolean(
    approval.details &&
      typeof approval.details === "object" &&
      !Array.isArray(approval.details) &&
      (approval.details as Record<string, unknown>).type === "localTool"
  );

const isPendingLocalApproval = (approval: ApprovalView) =>
  approval.status === "pending" && isLocalApproval(approval);

const isResolvedLocalApproval = (approval: ApprovalView) =>
  approval.status !== "pending" && isLocalApproval(approval);

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalView;
  onResolve: (decision: ApprovalDecision) => Promise<void>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const pending = approval.status === "pending";
  useEffect(() => {
    if (!pending) setDetailsOpen(false);
  }, [pending]);
  const details =
    approval.details && typeof approval.details === "object" && !Array.isArray(approval.details)
      ? (approval.details as Record<string, unknown>)
      : {};
  const action = typeof details.action === "string" ? details.action : null;
  const toolName = typeof details.toolName === "string" ? details.toolName : null;
  const heading = action
    ? action.replace(/([a-z])([A-Z])/g, "$1 $2")
    : toolName
      ? `Allow ${toolName}`
      : "Approval required";
  const effect = typeof details.effect === "string" ? details.effect : null;
  const supportsAlwaysAllow = details.supportsAlwaysAllow === true;
  const supportsNever = details.supportsNever === true;
  const localTool = details.type === "localTool";
  const autoReview = details.type === "autoReview";
  const resolution = typeof details.resolution === "string" ? details.resolution : null;
  const localCapability = details.action === "readFile" ? "read files on" : "run commands on";
  const visibleArguments = details.arguments;
  const argumentRecord =
    visibleArguments && typeof visibleArguments === "object" && !Array.isArray(visibleArguments)
      ? (visibleArguments as Record<string, unknown>)
      : {};
  const machineLabel =
    typeof details.machineLabel === "string" && details.machineLabel.trim()
      ? details.machineLabel.trim()
      : "this computer";

  if (localTool) {
    const command = typeof argumentRecord.command === "string" ? argumentRecord.command : null;
    const path = typeof argumentRecord.path === "string" ? argumentRecord.path : null;
    const rawDetails = command ?? path;
    const detailsLabel = command ? "command" : "details";
    const statusLabel =
      resolution === "accept"
        ? `OpenBot can ${localCapability} your computer this time.`
        : resolution === "always_allow"
          ? `OpenBot can always ${localCapability} your computer.`
          : approval.status === "declined"
            ? `OpenBot was not allowed to ${localCapability} your computer.`
            : approval.status === "cancelled"
              ? "Local computer approval was cancelled."
              : approval.status === "expired"
                ? "Local computer approval expired."
                : "OpenBot was not allowed to use your computer.";

    if (!pending) {
      return (
        <div
          aria-label="Local tool permission result"
          className={cn(
            "min-h-6 w-full min-w-0 truncate text-center text-[12px] leading-4",
            approvalSecondaryTextClass
          )}
          data-approval-id={approval.id}
          data-approval-status={approval.status}
          data-local-tool-permission-result=""
          title={statusLabel}
        >
          {statusLabel}
        </div>
      );
    }

    return (
      <div
        aria-label="Local tool permission"
        className={approvalCardClass}
        data-approval-id={approval.id}
        data-approval-status={approval.status}
        data-local-tool-permission=""
      >
        <div className={approvalContentClass}>
          <div className="flex w-full min-w-0 items-start gap-2">
            <span className="inline-flex h-[22px] shrink-0 items-center">
              <TriangleAlert
                aria-hidden="true"
                className="size-4 text-[#d08770]"
                strokeWidth={1.75}
              />
            </span>
            <div className={approvalTitleClass}>{effect ?? heading}</div>
            <button
              aria-label="Deny once"
              className="grid size-5 shrink-0 place-items-center rounded-md text-[#141414]/60 outline-none hover:bg-[#141414]/[0.04] hover:text-[#141414] focus-visible:ring-2 focus-visible:ring-ring/30 dark:text-[#f0f0f0]/60 dark:hover:bg-[#f0f0f0]/[0.04] dark:hover:text-[#f0f0f0]"
              onClick={() => void onResolve("decline")}
              type="button"
            >
              <X className="size-3" strokeWidth={1.75} />
            </button>
          </div>

          <div
            className={cn(
              "text-[12px] font-medium leading-4 [overflow-wrap:anywhere]",
              approvalSecondaryTextClass
            )}
          >
            {machineLabel}
          </div>
          <div
            className={cn(
              "text-[13px] leading-[18px] [overflow-wrap:anywhere]",
              approvalSecondaryTextClass
            )}
          >
            {"This applies to OpenBot and every Bot. It can always be changed in Settings."}
          </div>

          {rawDetails ? (
            <ApprovalDetails
              detailsLabel={detailsLabel}
              open={detailsOpen}
              rawDetails={rawDetails}
              setOpen={setDetailsOpen}
            />
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {supportsAlwaysAllow ? (
            <Button
              className={approvalPrimaryButtonClass}
              onClick={() => void onResolve("always_allow")}
            >
              Always allow
            </Button>
          ) : null}
          <Button
            className={approvalSecondaryButtonClass}
            onClick={() => void onResolve("accept")}
            variant="outline"
          >
            Allow once
          </Button>
          {supportsNever ? (
            <Button
              className={approvalSecondaryButtonClass}
              onClick={() => void onResolve("never")}
              variant="outline"
            >
              Never
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (autoReview) {
    const command = typeof argumentRecord.command === "string" ? argumentRecord.command : null;
    const path = typeof argumentRecord.path === "string" ? argumentRecord.path : null;
    const task = typeof argumentRecord.task === "string" ? argumentRecord.task : null;
    const prompt = typeof argumentRecord.prompt === "string" ? argumentRecord.prompt : null;
    const rawDetails =
      command ?? path ?? task ?? prompt ?? JSON.stringify(visibleArguments ?? {}, null, 2);
    const detailsLabel = command ? "command" : "details";
    const taskReview = details.action === "runTask";
    const suppliedSummary =
      typeof details.summary === "string" && details.summary.trim()
        ? details.summary.trim()
        : action === "readFile" && path
          ? `Read ${path}`
          : action === "runCommand"
            ? "Run a command"
            : heading;
    const reviewSummary = suppliedSummary;
    const reason = typeof details.reason === "string" ? details.reason : effect;
    const proposedRule =
      typeof details.proposedRule === "string" && details.proposedRule.trim()
        ? details.proposedRule.trim()
        : null;
    const reviewTitle =
      action === "runCommand"
        ? "The Bot wants to run a command"
        : action === "readFile"
          ? "The Bot wants to read a file"
          : "The Bot wants to run a task";
    const reviewStatus = pending
      ? "Approval needed"
      : approval.status === "accepted"
        ? resolution === "always_allow"
          ? "Always allowed"
          : "Allowed once"
        : approval.status === "declined"
          ? "Denied"
          : approval.status === "cancelled"
            ? "Cancelled"
            : approval.status === "expired"
              ? "Expired"
              : "Reviewed";

    return (
      <div
        aria-label="Auto-review approval"
        className={approvalCardClass}
        data-approval-id={approval.id}
        data-approval-status={approval.status}
        data-auto-review-approval=""
      >
        <div className={approvalContentClass}>
          <div className="flex w-full min-w-0 items-start gap-2">
            <div className={approvalTitleClass}>{reviewTitle}</div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] font-medium leading-[18px]",
                pending
                  ? "gap-1 bg-[#f1b467]/[0.22] pl-1 text-[#f1b467]"
                  : approval.status === "declined"
                    ? "bg-[#fc6b83]/[0.12] text-[#fc6b83]"
                    : "text-[#141414] dark:text-[#f0f0f0]"
              )}
            >
              {pending ? (
                <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.7} />
              ) : approval.status === "declined" ? (
                <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              ) : null}
              {reviewStatus}
            </span>
          </div>

          {!taskReview ? (
            <>
              <div
                className={cn(
                  "text-[12px] font-medium leading-4 [overflow-wrap:anywhere]",
                  approvalSecondaryTextClass
                )}
              >
                Runs on your local computer
              </div>
              <div className="text-[13px] leading-[1.45] text-[#141414] [overflow-wrap:anywhere] dark:text-[#f0f0f0]">
                {reviewSummary}
              </div>
            </>
          ) : null}
          {pending && reason ? (
            <div
              className={cn(
                "text-[13px] leading-[18px] [overflow-wrap:anywhere]",
                approvalSecondaryTextClass
              )}
            >
              {reason}
            </div>
          ) : null}

          {rawDetails ? (
            <ApprovalDetails
              detailsLabel={detailsLabel}
              open={detailsOpen}
              rawDetails={rawDetails}
              setOpen={setDetailsOpen}
            />
          ) : null}
          {!pending && resolution === "always_allow" ? (
            <div
              className={cn(
                "text-[13px] leading-[18px] [overflow-wrap:anywhere]",
                approvalSecondaryTextClass
              )}
            >
              {`A rule always allowing this was added to your Auto-review settings${
                proposedRule ? `: “${proposedRule}”` : ""
              }`}
            </div>
          ) : null}
        </div>

        {pending ? (
          <div className="flex flex-wrap gap-2">
            <Button className={approvalPrimaryButtonClass} onClick={() => void onResolve("accept")}>
              Allow once
            </Button>
            {supportsAlwaysAllow ? (
              <Button
                className={approvalSecondaryButtonClass}
                onClick={() => void onResolve("always_allow")}
                variant="outline"
              >
                Always allow
              </Button>
            ) : null}
            <Button
              className={approvalSecondaryButtonClass}
              onClick={() => void onResolve("decline")}
              variant="outline"
            >
              Deny
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const statusLabel =
    approval.status === "accepted"
      ? "Approved"
      : approval.status === "declined"
        ? "Declined"
        : approval.status === "cancelled"
          ? "Cancelled"
          : approval.status === "expired"
            ? "Expired"
            : "Approval required";

  return (
    <div
      className="rounded-xl border border-amber-500/25 bg-amber-500/8 p-3 text-sm"
      data-approval-id={approval.id}
      data-approval-status={approval.status}
    >
      <div className="mb-2 flex items-center gap-2 font-medium">
        {pending ? (
          <CircleAlert className="size-4 text-amber-500" />
        ) : (
          <Check className="size-4 text-foreground-secondary" />
        )}
        {pending ? (localTool ? effect : heading) : statusLabel}
      </div>
      {pending && localTool ? (
        <p className="mb-2 text-xs leading-5 text-muted-foreground">
          {typeof details.machineLabel === "string" ? details.machineLabel : "This computer"}. This
          applies to OpenBot and every Bot and can be changed in Settings.
        </p>
      ) : !localTool && effect ? (
        <p className="mb-2 text-xs leading-5 text-muted-foreground">{effect}</p>
      ) : null}
      {visibleArguments && typeof visibleArguments === "object" ? (
        <pre className="mb-3 max-h-40 overflow-auto rounded-lg bg-black/[0.04] p-2 whitespace-pre-wrap text-[11px] text-muted-foreground dark:bg-white/[0.05]">
          {JSON.stringify(visibleArguments, null, 2)}
        </pre>
      ) : null}
      {pending && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void onResolve("decline")} size="sm" variant="outline">
            Deny once
          </Button>
          {supportsAlwaysAllow ? (
            <Button onClick={() => void onResolve("always_allow")} size="sm" variant="outline">
              Always allow
            </Button>
          ) : null}
          <Button onClick={() => void onResolve("accept")} size="sm">
            <Check className="size-3.5" /> Allow once
          </Button>
          {supportsNever ? (
            <Button onClick={() => void onResolve("never")} size="sm" variant="outline">
              Never
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ApprovalDetails({
  detailsLabel,
  open,
  rawDetails,
  setOpen,
}: {
  detailsLabel: string;
  open: boolean;
  rawDetails: string;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <button
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 self-start text-[13px] leading-[18px] outline-none hover:text-[#141414] focus-visible:ring-2 focus-visible:ring-ring/30 dark:hover:text-[#f0f0f0]",
          approvalSecondaryTextClass
        )}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-3.5" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="size-3.5" strokeWidth={1.75} />
        )}
        {open ? `Hide the ${detailsLabel}` : `Show the ${detailsLabel}`}
      </button>
      {open ? (
        <div className="approval-code-figure relative w-full min-w-0 rounded-lg bg-[#141414]/[0.04] dark:bg-[#f0f0f0]/[0.04]">
          <pre
            className={cn(
              "grok-scrollbar max-h-40 overflow-auto whitespace-pre px-3 py-2 font-mono text-[13px] leading-5",
              approvalSecondaryTextClass
            )}
          >
            {rawDetails}
          </pre>
          <button
            aria-label="Copy code"
            className="approval-copy-button absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md border-[0.5px] border-[#141414]/[0.08] bg-[#fcfcfc] text-[#141414]/60 shadow-[0_1px_3px_#0000001f] outline-none hover:bg-[#f7f7f7] hover:text-[#141414] focus-visible:ring-2 focus-visible:ring-ring/30 dark:border-[#f0f0f0]/[0.08] dark:bg-[#383838] dark:text-[#f0f0f0]/60 dark:hover:bg-[#444] dark:hover:text-[#f0f0f0]"
            onClick={() => void navigator.clipboard.writeText(rawDetails)}
            type="button"
          >
            <Copy className="size-3.5" strokeWidth={1.7} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

const BotThinkingSlot = memo(function BotThinkingSlot({
  bot,
  phase,
}: {
  bot?: BotView;
  phase: ThinkingPhase;
}) {
  const name = bot?.name ?? "Bot";
  const mounted = phase !== "hidden";
  return (
    <div
      aria-hidden={!mounted}
      className="flex h-9 shrink-0 items-center"
      data-active={phase === "visible" || undefined}
      data-bot-thinking-slot=""
      data-phase={phase}
      data-timeline-entry="thinking"
    >
      {mounted ? (
        <div
          aria-label={`${name} is working`}
          aria-hidden={phase === "exiting" || undefined}
          className="bot-thinking-content flex min-w-0 items-center gap-2"
          data-bot-thinking=""
          data-exiting={phase === "exiting" || undefined}
          role="status"
        >
          <span aria-hidden="true" className="bot-thinking-badge">
            <span className="bot-thinking-dot" />
            <span className="bot-thinking-dot" />
            <span className="bot-thinking-dot" />
          </span>
          <span className="bot-thinking-label min-w-0 truncate whitespace-nowrap text-[14px] leading-5">
            {name} is working
          </span>
        </div>
      ) : null}
    </div>
  );
});

const A2AActivityRow = memo(function A2AActivityRow({
  count,
  onOpen,
  peer,
  peerName,
}: {
  count: number;
  onOpen?: (trigger: HTMLButtonElement) => void;
  peer?: BotView;
  peerName: string;
}) {
  const name = peer?.name ?? peerName;
  const peerContent = (
    <>
      <BotAvatar bot={peer} size="activity" />
      <span className="truncate">{name}</span>
    </>
  );
  return (
    <div
      className="mx-auto mt-2 flex h-6 items-center gap-1.5 px-2 text-xs text-muted-foreground dark:text-[#9a9a9a]"
      data-a2a-activity=""
    >
      <span className="leading-5">
        {count} {count === 1 ? "message" : "messages"} with
      </span>
      {onOpen ? (
        <button
          aria-label={`Open A2A exchange with ${name}`}
          className="inline-flex h-6 max-w-[min(320px,55vw)] items-center gap-1 rounded-full bg-transparent pl-1 pr-2 leading-5 text-inherit transition-colors hover:bg-[#efefef] focus-visible:bg-[#efefef] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:hover:bg-[#1b1b1b] dark:focus-visible:bg-[#1b1b1b]"
          data-a2a-peer-pill=""
          onClick={(event) => onOpen(event.currentTarget)}
          type="button"
        >
          {peerContent}
        </button>
      ) : (
        <span
          className="inline-flex h-6 max-w-[min(320px,55vw)] items-center gap-1 rounded-full bg-transparent pl-1 pr-2 leading-5"
          data-a2a-peer-pill=""
        >
          {peerContent}
        </span>
      )}
    </div>
  );
});

export const ChatPane = memo(function ChatPane({
  agentNameById,
  channel,
  selectedBot,
  messages,
  runs,
  subagents,
  approvalsByRun,
  botById,
  activeRun,
  runtime,
  mutate,
  focusMessage,
  onCloseViewOnly,
  onOpenA2A,
  onOpenRoutine,
  templateShareRequest,
}: ChatPaneProps) {
  const [now, setNow] = useState(() => new Date());
  const [replyTarget, setReplyTarget] = useState<{
    channelId: string;
    messageId: string;
  } | null>(null);
  const [composerHeight, setComposerHeight] = useState(60);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const [templateFlow, setTemplateFlow] = useState<
    { stage: "audience" } | { stage: "draft"; template: BotTemplateRecord } | null
  >(null);
  const [templatePreview, setTemplatePreview] = useState<BotTemplateRecord | null>(null);
  const handledTemplateRequest = useRef<number | null>(null);
  const templateFlowRef = useRef<HTMLDivElement | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const storedTemplate = useBotTemplateRecord(selectedBot?.id ?? "");
  const [threadState, setThreadState] = useState<{
    rootId: string;
    open: boolean;
  } | null>(null);
  const threadCloseTimer = useRef<number | null>(null);
  const knownMessageIds = useRef<Set<string> | null>(null);
  const knownMessageChannelId = useRef(channel.id);
  const enteringMessageIds = useMemo(() => {
    const known = knownMessageChannelId.current === channel.id ? knownMessageIds.current : null;
    if (!known) return new Set<string>();
    return new Set(
      messages.filter((message) => !known.has(message.id)).map((message) => message.id)
    );
  }, [channel.id, messages]);
  useEffect(() => {
    knownMessageChannelId.current = channel.id;
    knownMessageIds.current = new Set(messages.map((message) => message.id));
  }, [channel.id, messages]);
  const visibleMessages = useMemo(() => {
    const optimisticServerIds = new Set(
      optimisticMessages.flatMap(({ serverMessageId }) =>
        serverMessageId ? [serverMessageId] : []
      )
    );
    const authoritativeById = new Map(messages.map((message) => [message.id, message] as const));
    return [
      ...messages
        .filter((message) => !optimisticServerIds.has(message.id))
        .map((message) => ({
          renderKey: message.id,
          message,
          pending: false,
          animateEntrance: enteringMessageIds.has(message.id),
        })),
      ...optimisticMessages.map((optimistic) => ({
        renderKey: optimistic.localId,
        message:
          (optimistic.serverMessageId
            ? authoritativeById.get(optimistic.serverMessageId)
            : undefined) ?? optimistic.message,
        pending: optimistic.pending,
        animateEntrance: true,
      })),
    ].sort(
      (left, right) =>
        new Date(left.message.createdAt).getTime() - new Date(right.message.createdAt).getTime() ||
        left.renderKey.localeCompare(right.renderKey)
    );
  }, [enteringMessageIds, messages, optimisticMessages]);
  const messagesById = useMemo(
    () => new Map(visibleMessages.map(({ message }) => [message.id, message] as const)),
    [visibleMessages]
  );
  const messagesByAddress = useMemo(
    () =>
      new Map(
        visibleMessages.map(({ message }) => [channelMessageAddress(message), message] as const)
      ),
    [visibleMessages]
  );
  const threads = useMemo(
    () => deriveThreads(visibleMessages.map(({ message }) => message)),
    [visibleMessages]
  );
  const mainMessages = useMemo(
    () => visibleMessages.filter(({ message }) => !isBranchedMessage(message)),
    [visibleMessages]
  );
  const approvals = useMemo(
    () => conversationApprovals(runs, subagents, approvalsByRun),
    [approvalsByRun, runs, subagents]
  );
  const hasPendingApproval = approvals.some((approval) => approval.status === "pending");
  const pendingLocalApproval = useMemo(
    () =>
      approvals
        .filter(isPendingLocalApproval)
        .sort(
          (left, right) =>
            new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
        )
        .at(-1) ?? null,
    [approvals]
  );
  const timeline = useMemo(() => {
    const ordered = mainMessages
      .map(({ animateEntrance, message, pending, renderKey }) => ({
        type: "message" as const,
        id: renderKey,
        createdAt: message.createdAt,
        message,
        animateEntrance,
        pending,
      }))
      .sort(
        (left, right) =>
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
          left.id.localeCompare(right.id)
      );
    const messageTimeline =
      channel.kind === "bot_dm" ? collapseA2ATimeline(ordered, (entry) => entry.message) : ordered;
    return [
      ...messageTimeline,
      ...approvals.map((approval) => ({
        type: "approval" as const,
        id: approval.id,
        createdAt: approval.createdAt,
        approval,
      })),
    ].sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
        left.id.localeCompare(right.id)
    );
  }, [approvals, channel.kind, mainMessages]);
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
      row.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
      });
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
  const openThread = useCallback((message: ChannelMessageView) => {
    if (threadCloseTimer.current) window.clearTimeout(threadCloseTimer.current);
    setThreadState({ rootId: message.id, open: true });
  }, []);
  const closeThread = useCallback(() => {
    setThreadState((current) => (current ? { ...current, open: false } : null));
    if (threadCloseTimer.current) window.clearTimeout(threadCloseTimer.current);
    threadCloseTimer.current = window.setTimeout(() => setThreadState(null), 300);
  }, []);
  useEffect(
    () => () => {
      if (threadCloseTimer.current) window.clearTimeout(threadCloseTimer.current);
    },
    []
  );
  const reactToMessage = useCallback(
    (message: ChannelMessageView, emoji: string) => {
      void mutate(() => api.reactToMessage(message.id, emoji));
    },
    [mutate]
  );
  const mentionOptions = useMemo<MentionOption[]>(() => {
    const bots =
      channel.kind === "group"
        ? channel.members.flatMap((member) => {
            const bot = botById.get(member.botId);
            return bot ? [bot] : [];
          })
        : [...botById.values()].filter(
            (bot) => bot.status === "active" && bot.id !== selectedBot?.id
          );
    return [
      ...(channel.kind === "group" && channel.members.length >= 2
        ? [
            {
              id: "__everyone__",
              label: "everyone",
              handle: "everyone",
            },
          ]
        : []),
      ...bots.map((bot) => ({
        id: bot.id,
        label: bot.name,
        handle: mentionHandleFor(bot.name),
        color: bot.color,
        icon: bot.icon,
        hasAvatar: bot.hasAvatar,
        updatedAt: bot.updatedAt,
      })),
    ];
  }, [botById, channel.kind, channel.members, selectedBot?.id]);
  const submit = useCallback(
    async (content: string, attachments: AssetRef[], options?: { richText?: string }) => {
      const localId = `optimistic:${crypto.randomUUID()}`;
      const optimistic: OptimisticMessage = {
        localId,
        pending: true,
        serverMessageId: null,
        message: {
          id: localId,
          sequence: localId,
          channelId: channel.id,
          sender: "user",
          senderBotId: null,
          sourceRunId: null,
          content,
          metadata: {
            type: "text",
            ...(attachments.length ? { attachments } : {}),
            ...(replyingTo ? { replyTo: replyingTo.id } : {}),
            ...(options?.richText ? { richText: options.richText } : {}),
          },
          createdAt: new Date().toISOString(),
        },
      };
      setOptimisticMessages((current) => [...current, optimistic]);
      try {
        return await mutate(async () => {
          const accepted =
            channel.kind === "bot_dm" && selectedBot
              ? await api.sendMessage(
                  selectedBot.conversationId,
                  content,
                  attachments,
                  replyingTo?.id,
                  options
                )
              : await api.sendChannelMessage(
                  channel.id,
                  content,
                  attachments,
                  replyingTo?.id,
                  options
                );
          setOptimisticMessages((current) =>
            current.map((candidate) =>
              candidate.localId === localId
                ? {
                    ...candidate,
                    message: accepted.message,
                    pending: false,
                    serverMessageId: accepted.message.id,
                  }
                : candidate
            )
          );
          return accepted;
        });
      } catch (error) {
        setOptimisticMessages((current) =>
          current.filter((candidate) => candidate.localId !== localId)
        );
        throw error;
      }
    },
    [channel.id, channel.kind, mutate, replyingTo?.id, selectedBot]
  );
  const botCanQueue = selectedBot && ["provisioning", "active"].includes(selectedBot.status);
  const onboardingInProgress = Boolean(
    selectedBot && ["pending", "queued", "running"].includes(selectedBot.onboardingStatus)
  );
  const composerVisible = channel.kind !== "agent_dm" && !onboardingInProgress;
  const showThinkingIndicator = Boolean(
    activeRun && !hasPendingApproval && !(visibleMessages.length === 0 && onboardingInProgress)
  );
  const thinkingPhase = useThinkingPresence(showThinkingIndicator);
  const thinkingMounted = thinkingPhase !== "hidden";
  const renderedTimeline = useMemo(() => {
    const transcriptTimeline = timeline.filter(
      (entry) => entry.type !== "approval" || !isPendingLocalApproval(entry.approval)
    );
    return transcriptTimeline.length === 0
      ? transcriptTimeline
      : [
          ...transcriptTimeline,
          {
            type: "thinking" as const,
            id: "thinking-slot",
            createdAt:
              activeRun?.createdAt ?? transcriptTimeline.at(-1)?.createdAt ?? channel.createdAt,
            phase: thinkingPhase,
            bot: activeRun ? botById.get(activeRun.botId) : selectedBot,
          },
        ];
  },
    [activeRun, botById, channel.createdAt, selectedBot, thinkingPhase, timeline]
  );
  const transcriptBottomInset = composerVisible ? composerHeight + 24 : 4;
  const canSend =
    channel.kind !== "agent_dm" &&
    (channel.kind === "bot_dm" ? Boolean(botCanQueue) : runtime.agent === "ready");
  const resolveApproval = useCallback(
    (approvalId: string, decision: ApprovalDecision) =>
      mutate(() => api.resolveApproval(approvalId, decision)).then((value) => {
        const body =
          value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const result =
          body.result && typeof body.result === "object"
            ? (body.result as Record<string, unknown>)
            : {};
        if (typeof result.authorizationUrl === "string") {
          window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
        }
      }),
    [mutate]
  );
  useEffect(() => {
    const dock = composerDockRef.current;
    if (!(composerVisible && dock)) return;

    const update = () => {
      const nextHeight = dock.getBoundingClientRect().height;
      if (nextHeight <= 0) return;
      setComposerHeight((current) => (Math.abs(current - nextHeight) < 0.5 ? current : nextHeight));
    };
    const observer = new ResizeObserver(update);
    observer.observe(dock);
    update();
    return () => observer.disconnect();
  }, [channel.id, composerVisible]);
  useEffect(() => {
    if (!selectedBot || templateShareRequest?.botId !== selectedBot.id) return;
    if (handledTemplateRequest.current === templateShareRequest.nonce) return;
    handledTemplateRequest.current = templateShareRequest.nonce;
    const existing = botTemplateFor(selectedBot.id);
    if (existing?.status === "published") {
      setTemplatePreview(existing);
      return;
    }
    setTemplateFlow({ stage: "audience" });
  }, [selectedBot, templateShareRequest]);
  useEffect(() => {
    setTemplateFlow((current) => {
      if (storedTemplate) {
        return current?.stage === "audience"
          ? current
          : { stage: "draft", template: storedTemplate };
      }
      return current?.stage === "draft" ? null : current;
    });
  }, [storedTemplate]);
  useEffect(() => {
    if (!templateFlow) return;
    const frame = window.requestAnimationFrame(() => {
      templateFlowRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "end",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [templateFlow]);
  return (
    <div className="relative flex size-full min-h-0 flex-col bg-background">
      <Conversation>
        <ConversationTopDivider />
        <ConversationContent
          className="max-w-none gap-1 px-4 pt-10"
          style={{ paddingBottom: transcriptBottomInset }}
        >
          {timeline.length === 0 && onboardingInProgress ? (
            <>
              <div className="flex justify-center pb-3 pt-[26.5px]">
                <time
                  className="select-none text-xs tabular-nums text-muted-foreground"
                  dateTime={channel.createdAt}
                >
                  {formatIdleGapTimestamp(channel.createdAt, now)}
                </time>
              </div>
              <BotThinkingSlot bot={selectedBot} phase="visible" />
            </>
          ) : timeline.length === 0 ? (
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
            renderedTimeline.map((entry, index) => (
              <Fragment key={`${entry.type}:${entry.id}`}>
                {entry.type !== "thinking" &&
                  shouldShowIdleGapTimestamp(
                    renderedTimeline[index - 1]?.createdAt,
                    entry.createdAt
                  ) && (
                    <div
                      className={`flex justify-center pb-3 ${index === 0 ? "pt-[26.5px]" : "pt-6"}`}
                    >
                      <time
                        className="select-none text-xs tabular-nums text-muted-foreground"
                        dateTime={entry.createdAt}
                      >
                        {formatIdleGapTimestamp(entry.createdAt, now)}
                      </time>
                    </div>
                  )}
                {entry.type === "thinking" ? (
                  <BotThinkingSlot bot={entry.bot} phase={entry.phase} />
                ) : entry.type === "a2a" ? (
                  <A2AActivityRow
                    count={entry.entries.length}
                    onOpen={
                      entry.peerId && onOpenA2A
                        ? (trigger) => onOpenA2A(entry.peerId as string, trigger)
                        : undefined
                    }
                    peer={entry.peerId ? botById.get(entry.peerId) : undefined}
                    peerName={entry.peerName ?? "another agent"}
                  />
                ) : entry.type === "approval" ? (
                  <div
                    className={
                      isResolvedLocalApproval(entry.approval)
                          ? "mt-2 w-full min-w-0"
                          : "mr-auto mt-2 w-full min-w-0 max-w-[min(88%,520px,calc(100%-82px))]"
                    }
                  >
                    <ApprovalCard
                      approval={entry.approval}
                      onResolve={(decision) => resolveApproval(entry.approval.id, decision)}
                    />
                  </div>
                ) : (
                  <MessageRow
                    animateEntrance={entry.animateEntrance}
                    canInteract={canSend && !entry.pending && entry.message.sender !== "system"}
                    channel={channel}
                    groupPosition={appendThinkingIndicatorToGroup(
                      getMessageGroupPosition(
                        mainMessages.map(({ message }) => message),
                        mainMessages.findIndex(({ message }) => message.id === entry.message.id)
                      ),
                      (() => {
                        const following = renderedTimeline[index + 1];
                        return Boolean(
                          thinkingMounted &&
                            following?.type === "thinking" &&
                            entry.message.sender === "agent" &&
                            (!entry.message.senderBotId ||
                              !following.bot?.id ||
                              entry.message.senderBotId === following.bot.id)
                        );
                      })()
                    )}
                    message={entry.message}
                    pending={entry.pending}
                    onReact={reactToMessage}
                    onReply={replyToMessage}
                    onOpenThread={openThread}
                    onOpenRoutine={onOpenRoutine}
                    replyPreview={(() => {
                      const preview = replyPreviewFor(
                        entry.message,
                        messagesById,
                        messagesByAddress
                      );
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
                    separatedFromPrevious={(() => {
                      const previous = renderedTimeline[index - 1];
                      return Boolean(
                        previous &&
                          (previous.type !== "message" ||
                            !messagesShareGroup(previous.message, entry.message)) &&
                          !shouldShowIdleGapTimestamp(previous.createdAt, entry.message.createdAt)
                      );
                    })()}
                    senderBot={
                      entry.message.senderBotId ? botById.get(entry.message.senderBotId) : undefined
                    }
                    senderName={
                      entry.message.senderBotId
                        ? agentNameById.get(entry.message.senderBotId)
                        : undefined
                    }
                    threadReplyCount={threads.get(entry.message.id)?.replies.length ?? 0}
                  />
                )}
              </Fragment>
            ))
          )}
          {templateFlow && selectedBot && (
            <div
              className="mt-2 flex flex-col gap-2 px-2 pb-1"
              data-bot-template-flow=""
              ref={templateFlowRef}
            >
              <div className="ml-auto max-w-[min(78%,520px)] rounded-[20px] bg-primary px-4 py-2.5 text-[14px] leading-5 text-primary-foreground">
                {BOT_TEMPLATE_REQUEST}
              </div>
              <div className="mr-auto flex w-full max-w-[560px] items-end gap-2">
                <BotAvatar bot={selectedBot} size="activity" />
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 text-[13px] leading-[18px] text-foreground-secondary">
                    {templateFlow.stage === "audience"
                      ? "I’ll make a shareable copy of this bot."
                      : `${templateFlow.template.audience === "team" ? "Team" : "Public"} template ready.`}
                  </div>
                  {templateFlow.stage === "audience" ? (
                    <TemplateAudienceQuestion
                      onDismiss={() => setTemplateFlow(null)}
                      onSelect={(audience) => {
                        const template = createBotTemplateDraft(selectedBot, audience);
                        setTemplateFlow({
                          stage: "draft",
                          template,
                        });
                      }}
                    />
                  ) : (
                    <BotTemplateCard
                      onChange={(template) => setTemplateFlow({ stage: "draft", template })}
                      onView={() => setTemplatePreview(templateFlow.template)}
                      template={templateFlow.template}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </ConversationContent>
        <ConversationInitialBottom />
        <ConversationNewMessageBottom
          conversationId={channel.id}
          messageCount={timeline.length}
          showTail={thinkingMounted}
        />
        <ConversationScrollButton
          bottomInset={composerVisible ? composerHeight + 8 : 8}
          conversationId={channel.id}
          messageCount={timeline.length}
        />
      </Conversation>
      {channel.kind === "agent_dm" ? (
        <div className="a2a-exchange-footer mx-auto w-full max-w-[1040px] px-5 pb-4">
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <LockKeyhole className="size-3.5" />
            <span>This chat is view-only</span>
            {onCloseViewOnly && (
              <Button
                className="h-7 rounded-full px-3 text-xs"
                onClick={onCloseViewOnly}
                variant="secondary"
              >
                Close Chat
              </Button>
            )}
          </div>
        </div>
      ) : onboardingInProgress ? null : (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[3]"
          data-composer-dock=""
          ref={composerDockRef}
        >
          {pendingLocalApproval ? (
            <div
              className="pointer-events-auto relative z-[3] w-full min-w-0 px-4 pb-2"
              data-local-tool-permission-dock=""
            >
              <ApprovalCard
                approval={pendingLocalApproval}
                onResolve={(decision) => resolveApproval(pendingLocalApproval.id, decision)}
              />
            </div>
          ) : null}
          <PromptInput
            disabled={!canSend}
            docked
            key={channel.id}
            onCancelReply={() => setReplyTarget(null)}
            assetUrl={api.assetUrl}
            onUpload={api.uploadAsset}
            mentionOptions={mentionOptions}
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
          />
        </div>
      )}
      {threadState && messagesById.get(threadState.rootId) && (
        <ThreadTray
          assetUrl={api.assetUrl}
          botById={botById}
          mentionOptions={mentionOptions}
          onClose={closeThread}
          onSubmit={(content, attachments, options) => {
            const thread = threads.get(threadState.rootId);
            const replyTargetId = thread?.replies.at(-1)?.id ?? threadState.rootId;
            return mutate(() =>
              channel.kind === "bot_dm" && selectedBot
                ? api.sendMessage(selectedBot.conversationId, content, attachments, replyTargetId, {
                    ...options,
                    isFork: true,
                  })
                : api.sendChannelMessage(channel.id, content, attachments, replyTargetId, {
                    ...options,
                    isFork: true,
                  })
            );
          }}
          onUpload={api.uploadAsset}
          open={threadState.open}
          replies={threads.get(threadState.rootId)?.replies ?? []}
          root={messagesById.get(threadState.rootId) as ChannelMessageView}
        />
      )}
      {templatePreview && (
        <BotTemplateDetailsDialog
          onChange={(template) => {
            setTemplatePreview(template);
            setTemplateFlow((current) =>
              current?.stage === "draft" ? { stage: "draft", template } : current
            );
          }}
          onOpenChange={(open) => !open && setTemplatePreview(null)}
          open
          template={templatePreview}
        />
      )}
    </div>
  );
}, chatPanePropsEqual);
