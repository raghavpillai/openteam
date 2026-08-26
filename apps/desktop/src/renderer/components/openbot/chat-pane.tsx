import type {
  ApprovalDecision,
  ApprovalView,
  BotView,
  ChannelMessageView,
  ChannelView,
  ClientSnapshot,
  RunItemView,
  RunView,
} from "@openbot/contracts";
import { Check, CircleAlert, MessageCircle, Users } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../client/openbot-api";
import { formatIdleGapTimestamp, shouldShowIdleGapTimestamp } from "../../lib/message-timestamps";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "../ai-elements/message";
import { PromptInput } from "../ai-elements/prompt-input";
import { Shimmer } from "../ai-elements/shimmer";
import { Button } from "../ui/button";
import { BotAvatar } from "./avatar";

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
  runGroupsEqual(next.runs, previous.itemsByRun, next.itemsByRun) &&
  runGroupsEqual(next.runs, previous.approvalsByRun, next.approvalsByRun);

const MessageRow = memo(function MessageRow({
  message,
  channel,
  senderBot,
}: {
  message: ChannelMessageView;
  channel: ChannelView;
  senderBot?: BotView;
}) {
  const from =
    message.sender === "user" ? "user" : message.sender === "system" ? "system" : "assistant";
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
  return (
    <Message className="group/message" from={from}>
      {message.sender === "agent" && channel.kind !== "bot_dm" && (
        <div className="flex items-center gap-2 px-1 pt-2 text-xs text-muted-foreground">
          <BotAvatar bot={senderBot} size="sm" />
          <span>{senderBot?.name ?? "Bot"}</span>
        </div>
      )}
      <MessageContent from={from}>
        <MessageResponse>{message.content}</MessageResponse>
      </MessageContent>
      {reactions.length > 0 && (
        <div className="flex gap-1 px-1">
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
}: ChatPaneProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const submit = useCallback(
    (content: string) =>
      mutate(() =>
        channel.kind === "bot_dm" && selectedBot
          ? api.sendMessage(selectedBot.conversationId, content)
          : api.sendChannelMessage(channel.id, content)
      ),
    [channel.id, channel.kind, mutate, selectedBot]
  );
  const stop = useCallback(
    () => (activeRun ? mutate(() => api.cancelRun(activeRun.id)) : Promise.resolve()),
    [activeRun, mutate]
  );
  const botCanQueue = selectedBot && ["provisioning", "active"].includes(selectedBot.status);
  const canSend =
    channel.kind !== "agent_dm" &&
    (channel.kind === "bot_dm" ? Boolean(botCanQueue) : runtime.agent === "ready");
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <Conversation>
        <ConversationContent className="max-w-none gap-1 px-1 pb-6 pt-4">
          {messages.length === 0 ? (
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
                  <div className="flex justify-center py-6">
                    <time
                      className="select-none text-xs tabular-nums text-muted-foreground"
                      dateTime={message.createdAt}
                    >
                      {formatIdleGapTimestamp(message.createdAt, now)}
                    </time>
                  </div>
                )}
                <MessageRow
                  channel={channel}
                  message={message}
                  senderBot={message.senderBotId ? botById.get(message.senderBotId) : undefined}
                />
              </Fragment>
            ))
          )}
          {selectedBot &&
            messages.length === 0 &&
            ["pending", "queued", "running"].includes(selectedBot.onboardingStatus) && (
              <div className="flex items-center justify-center gap-2 px-1 py-2 text-sm text-muted-foreground">
                <BotAvatar bot={selectedBot} size="sm" />
                <Shimmer>
                  {selectedBot.status === "provisioning"
                    ? `Starting ${selectedBot.name}…`
                    : `${selectedBot.name} is opening the conversation…`}
                </Shimmer>
              </div>
            )}
          {activeRun && (
            <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
              <BotAvatar bot={botById.get(activeRun.botId)} size="sm" />
              <Shimmer>Working…</Shimmer>
            </div>
          )}
          <Activity approvalsByRun={approvalsByRun} mutate={mutate} runs={runs} />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {channel.kind === "agent_dm" ? (
        <div className="mx-auto w-full max-w-[1040px] px-5 pb-4">
          <div className="rounded-full border bg-muted/50 px-4 py-3 text-center text-xs text-muted-foreground">
            This bot-to-bot chat is view-only.
          </div>
        </div>
      ) : (
        <PromptInput
          disabled={!canSend}
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
          running={Boolean(activeRun)}
        />
      )}
    </div>
  );
}, chatPanePropsEqual);
