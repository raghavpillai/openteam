import type { RunView } from "@openteam/contracts";
import type { BotAvatarMode } from "@openteam/contracts/robot-avatar";

/** Activity belongs to the open conversation, even when a bot appears in several chats. */
export function resolveBotAvatarMode({
  activeChannel,
  run,
  botId,
  channelId,
}: {
  activeChannel?: { id: string; members: readonly { botId: string }[] } | null;
  run?: Pick<RunView, "botId" | "status">;
  botId?: string;
  channelId?: string | null;
}): BotAvatarMode {
  if (
    !activeChannel ||
    (channelId && channelId !== activeChannel.id) ||
    !botId ||
    !activeChannel.members.some((member) => member.botId === botId)
  )
    return "still";
  return run?.botId === botId && (run.status === "running" || run.status === "queued")
    ? "thinking"
    : "idle";
}
