import type { BotView, ChannelView } from "@openteam/contracts";
import { Avatar as AvatarPrimitive } from "radix-ui";
import { memo } from "react";
import { API_BASE } from "../../client/http";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import { cn } from "../../lib/cn";
import {
  type BotAvatarMode,
  BotAvatarGlyph,
  DEFAULT_BOT_AVATAR,
  normalizeBotAvatarShape,
} from "./avatar-picker-icons";

import { AvatarChannelContext, useBotAvatarMode } from "./bot-avatar-activity";

export const BotAvatar = memo(function BotAvatar({
  bot,
  size = "md",
  mode,
  channelId,
}: {
  bot?: Pick<BotView, "color" | "icon"> & Partial<Pick<BotView, "id" | "hasAvatar" | "updatedAt">>;
  size?: "xs" | "activity" | "sm" | "md" | "lg";
  mode?: BotAvatarMode;
  channelId?: string;
}) {
  const activityMode = useBotAvatarMode(bot?.id, channelId);
  const avatarUrl =
    bot?.hasAvatar && bot.id && bot.updatedAt
      ? `${API_BASE}/api/v0/bots/${bot.id}/avatar?v=${encodeURIComponent(bot.updatedAt)}`
      : null;
  const avatarSource = useAuthenticatedResource(avatarUrl);
  return (
    <AvatarPrimitive.Root
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden",
        size === "xs" && "size-4",
        size === "activity" && "size-4",
        size === "sm" && "size-[22px]",
        size === "md" && "size-9",
        size === "lg" && "size-16"
      )}
    >
      {avatarSource && (
        <AvatarPrimitive.Image
          alt=""
          className="size-full object-cover"
          decoding="async"
          loading="lazy"
          src={avatarSource}
        />
      )}
      <AvatarPrimitive.Fallback className="grid size-full place-items-center">
        <BotAvatarGlyph
          mode={mode ?? activityMode}
          className="size-full"
          color={bot?.color ?? DEFAULT_BOT_AVATAR.color}
          shape={normalizeBotAvatarShape(bot?.icon)}
        />
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
  size?: "sm" | "md" | "lg";
}) {
  if (channel.kind === "bot_dm") {
    return (
      <AvatarChannelContext.Provider value={channel.id}>
        <BotAvatar bot={botById.get(channel.members[0]?.botId ?? "")} size={size} />
      </AvatarChannelContext.Provider>
    );
  }
  if (channel.hasAvatar) {
    return (
      <span
        className={cn(
          "grid shrink-0 place-items-center overflow-hidden rounded-full",
          size === "sm" ? "size-5" : size === "lg" ? "size-16" : "size-8"
        )}
      >
        <img
          alt=""
          className="size-full object-cover"
          src={`${API_BASE}/api/v0/channels/${channel.id}/avatar?v=${encodeURIComponent(channel.updatedAt)}`}
        />
      </span>
    );
  }
  const members = channel.members.slice(0, 2).map((member) => botById.get(member.botId));
  return (
    <AvatarChannelContext.Provider value={channel.id}>
      <div
        className={cn(
          "relative shrink-0",
          size === "sm" ? "size-5" : size === "lg" ? "size-16" : "size-8"
        )}
      >
        {members.map((bot, index) => (
          <div
            className={cn("absolute", index === 0 ? "left-0 top-0" : "bottom-0 right-0")}
            key={bot?.id ?? index}
          >
            <BotAvatar bot={bot} size={size === "sm" ? "xs" : size === "lg" ? "md" : "sm"} />
          </div>
        ))}
      </div>
    </AvatarChannelContext.Provider>
  );
});
