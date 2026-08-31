import type { AssetRef, BotView, ChannelMessageView } from "@openbot/contracts";
import { X } from "lucide-react";
import type { MentionOption } from "../../lib/mentions";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { PromptInput } from "../ai-elements/prompt-input";
import { BotAvatar } from "./avatar";

const ThreadMessage = ({
  botById,
  message,
}: {
  botById: ReadonlyMap<string, BotView>;
  message: ChannelMessageView;
}) => {
  const bot = message.senderBotId ? botById.get(message.senderBotId) : undefined;
  const from = message.sender === "user" ? "user" : "assistant";
  return (
    <div
      className={`flex items-end gap-2 ${from === "user" ? "justify-end" : "justify-start"}`}
      data-thread-message-id={message.id}
    >
      {from !== "user" && <BotAvatar bot={bot} size="sm" />}
      <div className={`max-w-[82%] ${from === "user" ? "items-end" : "items-start"}`}>
        {from !== "user" && (
          <div className="mb-1 px-1 text-[11px] text-muted-foreground">{bot?.name ?? "Bot"}</div>
        )}
        <MessageContent from={from}>
          <MessageResponse>{message.content}</MessageResponse>
        </MessageContent>
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
  assetUrl,
  onClose,
  onSubmit,
  onUpload,
}: {
  botById: ReadonlyMap<string, BotView>;
  mentionOptions: readonly MentionOption[];
  open: boolean;
  replies: readonly ChannelMessageView[];
  root: ChannelMessageView;
  assetUrl: (asset: Pick<AssetRef, "assetId" | "fileName">) => string;
  onClose: () => void;
  onUpload: (input: {
    fileName: string;
    mimeType?: string;
    bytesBase64: string;
  }) => Promise<AssetRef>;
  onSubmit: (
    value: string,
    attachments: AssetRef[],
    options?: { richText?: string }
  ) => Promise<unknown> | undefined;
}) {
  return (
    <div
      aria-hidden={!open}
      className={`absolute inset-0 z-40 transition-colors duration-300 motion-reduce:duration-120 ${
        open ? "bg-black/15" : "pointer-events-none bg-transparent"
      }`}
      data-thread-overlay=""
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
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <ThreadMessage botById={botById} message={root} />
          <div className="my-4 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-3">
            {replies.map((message) => (
              <ThreadMessage botById={botById} key={message.id} message={message} />
            ))}
          </div>
        </div>
        <div className="shrink-0 border-t pt-3">
          <PromptInput
            assetUrl={assetUrl}
            key={root.id}
            mentionOptions={mentionOptions}
            onSubmit={onSubmit}
            onUpload={onUpload}
            placeholder="Reply in thread"
          />
        </div>
      </aside>
    </div>
  );
}
