import type { BotView, ChannelView } from "@openteam/contracts";
import { DEFAULT_BOT_AVATAR } from "@openteam/contracts/bot-avatar";
import { type BotAvatarMode, normalizeRobotAvatarShape } from "@openteam/contracts/robot-avatar";
import { Avatar as AvatarPrimitive } from "radix-ui";
import { memo } from "react";
import { API_BASE } from "../../client/http";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import { useAuthSession } from "../../hooks/use-auth-session";
import { accountPresentation } from "../../lib/account";
import { cn } from "../../lib/cn";
import { BotAvatarGlyph } from "./avatar-picker-icons";

import { AvatarChannelContext, useBotAvatarMode } from "./bot-avatar-activity";

export const BotAvatar = memo(function BotAvatar({
  bot,
  size = "md",
  mode,
  channelId,
  roster = false,
  className,
}: {
  bot?: Pick<BotView, "color" | "icon"> & Partial<Pick<BotView, "id" | "hasAvatar" | "updatedAt">>;
  size?: "xs" | "activity" | "sm" | "md" | "lg";
  mode?: BotAvatarMode;
  channelId?: string;
  /** Compensate for the robot artwork's inset in the expanded conversation list. */
  roster?: boolean;
  className?: string;
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
        roster && !avatarSource && "overflow-visible",
        size === "xs" && "size-4",
        size === "activity" && "size-4",
        size === "sm" && "size-[22px]",
        size === "md" && "size-9",
        size === "lg" && "size-16",
        className
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
          style={roster ? { transform: "scale(1.25)" } : undefined}
          color={bot?.color ?? DEFAULT_BOT_AVATAR.color}
          shape={normalizeRobotAvatarShape(bot?.icon)}
        />
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
});

function GroupAvatar({
  members,
  size,
}: {
  members: Array<BotView | undefined>;
  size: "sm" | "md" | "lg";
}) {
  const auth = useAuthSession();
  const account = accountPresentation(auth.user, auth.mode);
  const edge = size === "sm" ? 22 : size === "lg" ? 64 : 36;
  const pair = members.length === 1;
  const memberEdge = edge * (pair ? 2 / 3 : 5 / 9);

  return (
    <div className="relative shrink-0" data-group-avatar="" style={{ width: edge, height: edge }}>
      <span
        className="absolute top-0 grid place-items-center rounded-full border-[0.5px] border-[#d5d5d5] bg-[#ebebeb] font-normal leading-none text-[#666666] dark:border-[#393939] dark:bg-[#232323] dark:text-[#a5a5a5]"
        data-group-avatar-user=""
        style={{
          left: pair ? 0 : (edge - memberEdge) / 2,
          width: members.length ? memberEdge : edge,
          height: members.length ? memberEdge : edge,
          fontSize: edge * (members.length === 0 ? 1 / 3 : pair ? 1 / 6 : 1 / 9),
          ...(members.length === 0 ? { left: 0 } : {}),
        }}
      >
        {account.initials}
      </span>
      {members.map((bot, index) => (
        <div
          className="absolute bottom-0"
          data-group-avatar-bot=""
          key={bot?.id ?? index}
          style={{
            width: memberEdge,
            height: memberEdge,
            ...(pair || index === 1 ? { right: 0 } : { left: 0 }),
          }}
        >
          <BotAvatar bot={bot} className="size-full" roster />
        </div>
      ))}
    </div>
  );
}

export const ChannelAvatar = memo(function ChannelAvatar({
  channel,
  botById,
  size = "md",
  roster = false,
}: {
  channel: ChannelView;
  botById: ReadonlyMap<string, BotView>;
  size?: "sm" | "md" | "lg";
  roster?: boolean;
}) {
  if (channel.kind === "bot_dm") {
    return (
      <AvatarChannelContext.Provider value={channel.id}>
        <BotAvatar bot={botById.get(channel.members[0]?.botId ?? "")} size={size} roster={roster} />
      </AvatarChannelContext.Provider>
    );
  }
  if (channel.hasAvatar) {
    return (
      <span
        className={cn(
          "grid shrink-0 place-items-center overflow-hidden rounded-full",
          size === "sm" ? "size-[22px]" : size === "lg" ? "size-16" : "size-9"
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
  if (channel.kind === "group") {
    return (
      <AvatarChannelContext.Provider value={channel.id}>
        <GroupAvatar members={members} size={size} />
      </AvatarChannelContext.Provider>
    );
  }
  return (
    <AvatarChannelContext.Provider value={channel.id}>
      <div
        className={cn(
          "relative shrink-0",
          size === "sm" ? "size-5" : size === "lg" ? "size-16" : roster ? "size-9" : "size-8"
        )}
      >
        {members.map((bot, index) => (
          <div
            className={cn("absolute", index === 0 ? "left-0 top-0" : "bottom-0 right-0")}
            key={bot?.id ?? index}
          >
            <BotAvatar
              bot={bot}
              size={size === "sm" ? "xs" : size === "lg" ? "md" : "sm"}
              roster={roster}
            />
          </div>
        ))}
      </div>
    </AvatarChannelContext.Provider>
  );
});
