import type { BotView, ChannelView } from "@openbot/contracts";
import { memo } from "react";
import { Avatar as AvatarPrimitive } from "radix-ui";
import { API_BASE } from "../../client/http";
import { cn } from "../../lib/cn";

export const BotAvatar = memo(function BotAvatar({
  bot,
  size = "md",
}: {
  bot?: Pick<BotView, "color" | "icon"> & Partial<Pick<BotView, "id" | "hasAvatar" | "updatedAt">>;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden",
        size === "xs" && "size-4",
        size === "sm" && "size-5",
        size === "md" && "size-8",
        size === "lg" && "size-16"
      )}
    >
      {bot?.hasAvatar && bot.id && bot.updatedAt && (
        <AvatarPrimitive.Image
          alt=""
          className="size-full object-cover"
          src={`${API_BASE}/api/v0/bots/${bot.id}/avatar?v=${encodeURIComponent(bot.updatedAt)}`}
        />
      )}
      <AvatarPrimitive.Fallback className="grid size-full place-items-center">
        <svg aria-hidden="true" className="size-full" viewBox="0 0 40 40">
          <path
            d="M20 0c2.8 6.7 11.2 10.5 14.1 17.9 4 10.4-2.2 20-12.9 20.7C10 40 4 33.3 4.8 23.9 5.6 15.5 15.2 7.4 20 0Z"
            fill={bot?.color ?? "#8b5cf6"}
          />
          <ellipse cx="16.1" cy="22" fill="white" rx="1.7" ry="3.2" />
          <ellipse cx="25.4" cy="22" fill="white" rx="1.7" ry="3.2" />
        </svg>
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
});

export const ChannelAvatar = memo(function ChannelAvatar({
  channel,
  botById,
  size = "md",
}: {
  channel: ChannelView;
  botById: ReadonlyMap<string, BotView>;
  size?: "sm" | "md";
}) {
  if (channel.kind === "bot_dm") {
    return <BotAvatar bot={botById.get(channel.members[0]?.botId ?? "")} size={size} />;
  }
  const members = channel.members.slice(0, 2).map((member) => botById.get(member.botId));
  return (
    <div className={cn("relative shrink-0", size === "sm" ? "size-5" : "size-8")}>
      {members.map((bot, index) => (
        <div
          className={cn("absolute", index === 0 ? "left-0 top-0" : "bottom-0 right-0")}
          key={bot?.id ?? index}
        >
          <BotAvatar bot={bot} size={size === "sm" ? "xs" : "sm"} />
        </div>
      ))}
    </div>
  );
});
