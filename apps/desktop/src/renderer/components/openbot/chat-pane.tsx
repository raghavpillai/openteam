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
  SubagentActivityView,
} from "@openbot/contracts";
import {
  Check,
  CircleAlert,
  Copy,
  Ellipsis,
  LockKeyhole,
  MessageCircle,
  Reply,
  Smile,
  Users,
} from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../client/openbot-api";
import { a2aProjectionFor, collapseA2ATimeline } from "../../lib/a2a-events";
import { channelNameChangedEventFor } from "../../lib/channel-events";
import { formatIdleGapTimestamp, shouldShowIdleGapTimestamp } from "../../lib/message-timestamps";
import { mentionHandleFor, type MentionOption } from "../../lib/mentions";
import { conversationApprovals } from "../../lib/subagent-activity";
import { deriveThreads, isBranchedMessage } from "../../lib/threads";
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
import { Shimmer } from "../ai-elements/shimmer";
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
  runGroupsEqual(next.runs, previous.itemsByRun, next.itemsByRun) &&
  runGroupsEqual(next.runs, previous.approvalsByRun, next.approvalsByRun) &&
  subagentApprovalGroupsEqual(next.subagents, previous.approvalsByRun, next.approvalsByRun);

type MessageGroupPosition = "single" | "first" | "middle" | "last";

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
  message: Pick<ChannelMessageView, "sender" | "senderBotId"> & { metadata?: unknown },
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
  threadReplyCount,
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
  threadReplyCount: number;
}) {
  const channelEvent = channelNameChangedEventFor(message);
  const from =
    message.sender === "user" ? "user" : message.sender === "system" ? "system" : "assistant";
  const hasAgentGutter = message.sender === "agent" && channel.kind !== "bot_dm";
  const showAgentAvatar =
    hasAgentGutter && (groupPosition === "single" || groupPosition === "last");
  const a2aProjection = channel.kind === "bot_dm" ? a2aProjectionFor(message) : null;
  const userReactions = getUserReactions(message);
  const userReactionSet = new Set(userReactions);
  const images = messageImages(message);
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
            className={`flex w-full max-w-full ${hasAgentGutter ? "gap-[5px]" : "gap-2"} ${
              images.length > 0 ? "items-end" : "items-center"
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
            {images.length > 0 ? (
              <div
                className={`flex max-w-[min(640px,78%)] flex-col gap-1.5 ${
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

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalView;
  onResolve: (decision: ApprovalDecision) => Promise<void>;
}) {
  const pending = approval.status === "pending";
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
        {statusLabel}
      </div>
      <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
        {JSON.stringify(approval.details, null, 2)}
      </pre>
      {pending && (
        <div className="flex gap-2">
          <Button onClick={() => void onResolve("accept")} size="sm">
            <Check className="size-3.5" /> Allow
          </Button>
          <Button onClick={() => void onResolve("decline")} size="sm" variant="outline">
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}

const BotThinkingIndicator = memo(function BotThinkingIndicator({ bot }: { bot?: BotView }) {
  const name = bot?.name ?? "Bot";
  return (
    <div
      aria-label={`${name} is working`}
      className="group/working flex h-8 items-center px-5"
      data-bot-thinking=""
      role="status"
    >
      <span aria-hidden="true" className="flex w-7 shrink-0 items-center gap-[3px]">
        {[0, 1, 2].map((index) => (
          <span
            className="size-[7px] rounded-full motion-safe:animate-[working-dot_1.05s_ease-in-out_infinite]"
            key={index}
            style={{
              animationDelay: `${index * 140}ms`,
              backgroundColor: bot?.color ?? "#ff7a1a",
            }}
          />
        ))}
      </span>
      <span className="ml-2 opacity-0 transition-opacity duration-150 ease-out group-hover/working:opacity-100 group-focus-within/working:opacity-100 motion-reduce:transition-none">
        <Shimmer className="whitespace-nowrap text-[14px] leading-5">{name} is working</Shimmer>
      </span>
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
  const content = (
    <>
      <span className="leading-5">
        {count} {count === 1 ? "message" : "messages"} with
      </span>
      <span
        className="inline-flex h-6 max-w-[min(320px,55vw)] items-center gap-1 rounded-full bg-transparent pl-1 pr-2 leading-5 transition-colors group-hover/a2a:bg-[#1b1b1b]"
        data-a2a-peer-pill=""
      >
        <BotAvatar bot={peer} size="activity" />
        <span className="truncate">{peer?.name ?? peerName}</span>
      </span>
    </>
  );
  return onOpen ? (
    <button
      className="group/a2a mx-auto mt-2 flex h-6 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:text-[#9a9a9a]"
      data-a2a-activity=""
      onClick={(event) => onOpen(event.currentTarget)}
      type="button"
    >
      {content}
    </button>
  ) : (
    <div
      className="mx-auto mt-2 flex h-6 items-center gap-1.5 px-2 text-xs text-muted-foreground dark:text-[#9a9a9a]"
      data-a2a-activity=""
    >
      {content}
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
}: ChatPaneProps) {
  const [now, setNow] = useState(() => new Date());
  const [replyTarget, setReplyTarget] = useState<{
    channelId: string;
    messageId: string;
  } | null>(null);
  const [pendingImageCount, setPendingImageCount] = useState(0);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [threadState, setThreadState] = useState<{ rootId: string; open: boolean } | null>(null);
  const threadCloseTimer = useRef<number | null>(null);
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message] as const)),
    [messages]
  );
  const messagesByAddress = useMemo(
    () => new Map(messages.map((message) => [channelMessageAddress(message), message] as const)),
    [messages]
  );
  const threads = useMemo(() => deriveThreads(messages), [messages]);
  const mainMessages = useMemo(
    () => messages.filter((message) => !isBranchedMessage(message)),
    [messages]
  );
  const approvals = useMemo(
    () => conversationApprovals(runs, subagents, approvalsByRun),
    [approvalsByRun, runs, subagents]
  );
  const timeline = useMemo(() => {
    const ordered = mainMessages
      .map((message) => ({
        type: "message" as const,
        id: message.id,
        createdAt: message.createdAt,
        message,
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
    (content: string, images: InlineImageInput[], options?: { richText?: string }) =>
      mutate(() =>
        channel.kind === "bot_dm" && selectedBot
          ? api.sendMessage(selectedBot.conversationId, content, images, replyingTo?.id, options)
          : api.sendChannelMessage(channel.id, content, images, replyingTo?.id, options)
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
    <div className="relative flex size-full min-h-0 flex-col bg-background">
      <Conversation>
        <ConversationTopDivider />
        <ConversationContent
          className={`max-w-none gap-1 px-1 pt-10 transition-[padding-bottom] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
            pendingImageCount > 0 ? "pb-24" : composerExpanded ? "pb-16" : "pb-6"
          }`}
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
              <BotThinkingIndicator bot={selectedBot} />
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
            timeline.map((entry, index) => (
              <Fragment key={`${entry.type}:${entry.id}`}>
                {shouldShowIdleGapTimestamp(timeline[index - 1]?.createdAt, entry.createdAt) && (
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
                {entry.type === "a2a" ? (
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
                  <div className="mx-auto mt-3 w-full max-w-[640px]">
                    <ApprovalCard
                      approval={entry.approval}
                      onResolve={(decision) =>
                        mutate(() => api.resolveApproval(entry.approval.id, decision)).then(
                          () => undefined
                        )
                      }
                    />
                  </div>
                ) : (
                  <MessageRow
                    canInteract={canSend && entry.message.sender !== "system"}
                    channel={channel}
                    groupPosition={getMessageGroupPosition(
                      mainMessages,
                      mainMessages.findIndex((message) => message.id === entry.message.id)
                    )}
                    message={entry.message}
                    onReact={reactToMessage}
                    onReply={replyToMessage}
                    onOpenThread={openThread}
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
                      const previous = timeline[index - 1];
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
          {activeRun && !(messages.length === 0 && onboardingInProgress) && (
            <BotThinkingIndicator bot={botById.get(activeRun.botId)} />
          )}
        </ConversationContent>
        <ConversationViewportAnchor active={composerExpanded || pendingImageCount > 0} />
        <ConversationScrollButton conversationId={channel.id} messageCount={timeline.length} />
      </Conversation>
      {channel.kind === "agent_dm" ? (
        <div className="mx-auto w-full max-w-[1040px] px-5 pb-4">
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
        <PromptInput
          disabled={!canSend}
          key={channel.id}
          onCancelReply={() => setReplyTarget(null)}
          onExpandedChange={setComposerExpanded}
          onImagesChange={setPendingImageCount}
          mentionOptions={mentionOptions}
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
      {threadState && messagesById.get(threadState.rootId) && (
        <ThreadTray
          botById={botById}
          mentionOptions={mentionOptions}
          onClose={closeThread}
          onSubmit={(content, images, options) => {
            const thread = threads.get(threadState.rootId);
            const replyTargetId = thread?.replies.at(-1)?.id ?? threadState.rootId;
            return mutate(() =>
              channel.kind === "bot_dm" && selectedBot
                ? api.sendMessage(selectedBot.conversationId, content, images, replyTargetId, {
                    ...options,
                    isFork: true,
                  })
                : api.sendChannelMessage(channel.id, content, images, replyTargetId, {
                    ...options,
                    isFork: true,
                  })
            );
          }}
          open={threadState.open}
          replies={threads.get(threadState.rootId)?.replies ?? []}
          root={messagesById.get(threadState.rootId) as ChannelMessageView}
        />
      )}
    </div>
  );
}, chatPanePropsEqual);
