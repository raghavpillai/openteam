import type { BotView, ChannelView } from "@openbot/contracts";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { PromptInput } from "../ai-elements/prompt-input";
import { ChannelAvatar } from "./avatar";

export function NewChannelScreen({
  channels,
  botById,
  onCreateBot,
  onSelect,
}: {
  channels: ChannelView[];
  botById: ReadonlyMap<string, BotView>;
  onCreateBot: () => void;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return channels.filter(
      (channel) =>
        channel.kind !== "agent_dm" &&
        (!normalized || channel.name.toLowerCase().includes(normalized))
    );
  }, [channels, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="electron-drag relative flex h-11 shrink-0 items-center border-b px-2 text-[12px] text-[#5b5b5b]">
        <span className="shrink-0">To:</span>
        <input
          aria-label="Search or create bots"
          autoFocus
          className="electron-no-drag min-w-0 flex-1 bg-transparent px-1 text-[12px] text-[#101010] outline-none placeholder:text-[#5b5b5b]"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search or create Bots"
          value={query}
        />
        <div className="absolute left-[33px] top-9 z-20 w-[560px] max-w-[calc(100%-48px)] overflow-hidden rounded-[13px] border border-[#d0d0d0] bg-background text-[#101010] shadow-[0_12px_30px_rgba(0,0,0,0.11)]">
          <div className="p-1.5">
            <button
              className="flex h-9 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] hover:bg-[#ededed]"
              onClick={onCreateBot}
              type="button"
            >
              <span className="grid size-5 place-items-center rounded-full bg-[#ececec] text-[#5e5e5e]">
                <Plus className="size-3.5" />
              </span>
              Create new Bot
            </button>
            {matches.map((channel, index) => (
              <button
                className={`flex h-9 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] ${index === 0 ? "bg-[#e0e0e0]" : "hover:bg-[#ededed]"}`}
                key={channel.id}
                onClick={() => onSelect(channel.id)}
                type="button"
              >
                <ChannelAvatar botById={botById} channel={channel} size="sm" />
                <span className="truncate">{channel.name}</span>
              </button>
            ))}
          </div>
          <div className="flex h-8 items-center justify-end gap-2 border-t px-2.5 text-[10px] text-[#5b5b5b]">
            <kbd className="rounded border border-[#dcdcdc] bg-[#eaeaea] px-1 py-0.5 font-sans text-[#585858]">
              Tab
            </kbd>
            <span>add</span>
            <kbd className="rounded border border-[#dcdcdc] bg-[#eaeaea] px-1 py-0.5 font-sans text-[#585858]">
              ↵
            </kbd>
            <span>open</span>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1" />
      <PromptInput disabled onSubmit={() => undefined} placeholder="Message Bot" />
    </div>
  );
}
