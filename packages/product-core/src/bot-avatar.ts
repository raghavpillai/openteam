import type { RunView } from "@openteam/contracts";
import type { BotAvatarMode } from "@openteam/contracts/robot-avatar";

/** Each conversation shows its own activity, including chats outside the open pane. */
export function resolveBotAvatarMode({
  activeChannel,
  run,
  botId,
  channelId,
  runsByChannel,
}: {
  activeChannel?: { id: string; members: readonly { botId: string }[] } | null;
  run?: Pick<RunView, "botId" | "status">;
  botId?: string;
  channelId?: string | null;
  runsByChannel?: ReadonlyMap<string, readonly Pick<RunView, "botId" | "status">[]>;
}): BotAvatarMode {
  if (
    !botId ||
    (!channelId && !activeChannel?.members.some((member) => member.botId === botId))
  )
    return "still";
  const scope = channelId ?? activeChannel!.id;
  const runs = runsByChannel?.get(scope)
    ?? (scope === activeChannel?.id && run ? [run] : []);
  return runs.some(candidate => candidate.botId === botId
    && (candidate.status === "running" || candidate.status === "queued"))
    ? "thinking"
    : "idle";
}
