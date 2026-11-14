import type { ChannelMessageView, RunItemView, RunView } from "@openteam/contracts";
import type { BotAvatarMode } from "@openteam/contracts/robot-avatar";

/** What a running Bot is doing right now, from its newest live run item. */
export type BotActivityKind =
  | "thinking"
  | "typing"
  | "searching"
  | "reading-web"
  | "browsing"
  | "reading-file"
  | "running-commands"
  | "waiting-command"
  | "waiting-you"
  | "connecting"
  | "computer"
  | "messaging"
  | "delegating"
  | "generating"
  | "drafting"
  | "organizing"
  | "working";

const TOOL_ACTIVITY: Readonly<Record<string, BotActivityKind>> = {
  SendToUser: "typing",
  read: "reading-file",
  Read: "reading-file",
  ReadFile: "reading-file",
  BoxRead: "reading-file",
  Skill: "reading-file",
  WebSearch: "searching",
  web_search: "searching",
  PlacesSearch: "searching",
  WeatherForecast: "searching",
  WebFetch: "reading-web",
  web_fetch: "reading-web",
  RemapUserFormTargets: "browsing",
  write: "drafting",
  edit: "drafting",
  Write: "drafting",
  Edit: "drafting",
  Shell: "running-commands",
  ExternalShell: "running-commands",
  bash: "running-commands",
  BoxShell: "running-commands",
  Await: "waiting-command",
  AwaitProcess: "waiting-command",
  AwaitShell: "waiting-command",
  RequestUserForm: "waiting-you",
  Computer: "computer",
  Screenshot: "computer",
  request_box_help: "computer",
  SendToAgent: "messaging",
  UpdateAgent: "messaging",
  CreateAgent: "messaging",
  ReactToMessage: "messaging",
  SendIMessage: "messaging",
  // Apps: a connector call, or setting one up.
  CallDynamicTool: "connecting",
  GetDynamicTools: "connecting",
  SearchPlugins: "connecting",
  GetPlugin: "connecting",
  InstallPlugin: "connecting",
  UninstallPlugin: "connecting",
  GetMcpServerStatus: "connecting",
  AddMcpServer: "connecting",
  UninstallMcpServer: "connecting",
  AuthenticateMcpServer: "connecting",
  RestartMcpServers: "connecting",
  SetMcpInstructions: "connecting",
  Task: "delegating",
  CheckSubagent: "delegating",
  GenerateImage: "generating",
};

/** Project only active runtime items; never read tool arguments or reasoning text. */
export function botActivityKind(items: readonly RunItemView[] = []): BotActivityKind {
  let latest: RunItemView | undefined;
  for (const item of items) {
    if (item.status !== "running" && item.status !== "pending") continue;
    if (
      !latest ||
      item.createdAt > latest.createdAt ||
      (item.createdAt === latest.createdAt && item.updatedAt >= latest.updatedAt)
    )
      latest = item;
  }
  // Clients never receive reasoning steps, so a running Bot with no live step is thinking.
  if (!latest) return "thinking";
  if (latest.kind === "reasoning") return "thinking";
  if (latest.kind === "command") return "running-commands";
  if (latest.kind === "file_change") return "drafting";
  if (latest.kind === "compaction") return "organizing";
  // Runtime agent text is internal, not necessarily a message being sent to the user.
  const content =
    latest.content && typeof latest.content === "object"
      ? (latest.content as Record<string, unknown>)
      : {};
  const tool = typeof content.tool === "string" ? content.tool : (latest.title ?? "");
  return (
    TOOL_ACTIVITY[tool] ??
    (tool.startsWith("browser_") ? "browsing" : latest.kind === "agent_message" ? "thinking" : "working")
  );
}

/**
 * Reasoning, searching, generating, apps and waits, writing a file and messaging get a
 * glyph; hands-on work (reading, commands, the computer, a subagent) keeps the robot working.
 */
export function activityAvatarMode(kind: BotActivityKind): BotAvatarMode {
  switch (kind) {
    case "thinking":
      return "thinking";
    case "typing":
      return "typing";
    case "searching":
      return "searching";
    case "generating":
      return "generating";
    case "connecting":
    case "waiting-command":
    case "waiting-you":
      return "connecting";
    case "drafting":
      return "writing";
    case "messaging":
      return "sending";
    default:
      return "working";
  }
}

/** A run that settled while this client watched it, keyed by conversation and Bot. */
export type SettledBotRun = { status: "completed" | "failed"; at: number };

/** A settled run shows its outcome this long. The avatar plays its reaction, then rests. */
export const BOT_AVATAR_DONE_MS = 8_000;
export const BOT_AVATAR_FAILED_MS = 8_000;

const WAITING_CARD_TYPES = new Set([
  "external-draft",
  "imessage-send",
  "user-form",
  "secret-request",
]);

/** A card the Bot left for the person, still waiting for their answer. */
export function isWaitingOnUser(
  message: Pick<ChannelMessageView, "sender" | "senderBotId" | "metadata"> | undefined,
  botId: string
): boolean {
  if (!message || message.sender !== "agent" || message.senderBotId !== botId) return false;
  const metadata =
    message.metadata && typeof message.metadata === "object"
      ? (message.metadata as Record<string, unknown>)
      : {};
  if (typeof metadata.type !== "string" || !WAITING_CARD_TYPES.has(metadata.type)) return false;
  if (metadata.type === "secret-request") return metadata.secretProvided !== true;
  const state = metadata.cardState;
  return state === undefined || state === null || state === "pending";
}

export const settledRunKey = (channelId: string, botId: string) => `${channelId}\u0000${botId}`;

type WatchedRun = { status: RunView["status"]; channelId: string; botId: string };
export type WatchedBotRuns = {
  runs: Map<string, WatchedRun>;
  settled: Map<string, SettledBotRun>;
};
export const createWatchedBotRuns = (): WatchedBotRuns => ({ runs: new Map(), settled: new Map() });

/**
 * Fold a new snapshot of runs into what this client has watched. A run that goes from
 * queued or running to completed or failed records a reaction for its Bot in that
 * conversation; runs first seen already settled never do. Background conversations only
 * list active runs, so a run that disappears there counts as completed when its Bot wrote
 * the conversation's newest message. Returns whether anything changed.
 */
export function observeSettledRuns(
  watched: WatchedBotRuns,
  runsByChannel: ReadonlyMap<string, readonly Pick<RunView, "id" | "botId" | "status">[]>,
  at: number,
  latestMessageByChannel?: ReadonlyMap<string, Pick<ChannelMessageView, "sender" | "senderBotId">>
): boolean {
  const active = (status: RunView["status"]) => status === "running" || status === "queued";
  let changed = false;
  const seen = new Set<string>();
  for (const [channelId, runs] of runsByChannel) {
    for (const run of runs) {
      seen.add(run.id);
      const previous = watched.runs.get(run.id)?.status;
      watched.runs.set(run.id, { status: run.status, channelId, botId: run.botId });
      const key = settledRunKey(channelId, run.botId);
      if (active(run.status)) {
        if (watched.settled.delete(key)) changed = true;
        continue;
      }
      if (!previous || !active(previous)) continue;
      if (run.status === "completed" || run.status === "failed")
        watched.settled.set(key, { status: run.status, at });
      else watched.settled.delete(key);
      changed = true;
    }
  }
  for (const [id, run] of watched.runs) {
    if (seen.has(id)) continue;
    watched.runs.delete(id);
    if (!active(run.status)) continue;
    const latest = latestMessageByChannel?.get(run.channelId);
    if (latest?.sender !== "agent" || latest.senderBotId !== run.botId) continue;
    watched.settled.set(settledRunKey(run.channelId, run.botId), { status: "completed", at });
    changed = true;
  }
  return changed;
}

export function settledAvatarMode(
  settled: SettledBotRun | undefined,
  now: number
): BotAvatarMode | null {
  if (!settled) return null;
  const elapsed = now - settled.at;
  if (elapsed < 0) return null;
  if (settled.status === "completed") return elapsed < BOT_AVATAR_DONE_MS ? "done" : null;
  return elapsed < BOT_AVATAR_FAILED_MS ? "failed" : null;
}

/** Each conversation shows its own activity, including chats outside the open pane. */
export function resolveBotAvatarMode({
  activeChannel,
  run,
  botId,
  channelId,
  runsByChannel,
  itemsByRun,
  latestMessage,
  settled,
  now = 0,
}: {
  activeChannel?: { id: string; members: readonly { botId: string }[] } | null;
  run?: Pick<RunView, "botId" | "status"> & Partial<Pick<RunView, "id">>;
  botId?: string;
  channelId?: string | null;
  runsByChannel?: ReadonlyMap<
    string,
    readonly (Pick<RunView, "botId" | "status"> & Partial<Pick<RunView, "id">>)[]
  >;
  itemsByRun?: ReadonlyMap<string, readonly RunItemView[]>;
  /** The newest message in the avatar's conversation. */
  latestMessage?: Pick<ChannelMessageView, "sender" | "senderBotId" | "metadata">;
  /** The Bot's last run in this conversation, when this client saw it settle. */
  settled?: SettledBotRun;
  now?: number;
}): BotAvatarMode {
  if (
    !botId ||
    (!channelId && !activeChannel?.members.some((member) => member.botId === botId))
  )
    return "still";
  const scope = channelId ?? activeChannel!.id;
  const runs = runsByChannel?.get(scope) ?? (scope === activeChannel?.id && run ? [run] : []);
  const active = runs.find(
    (candidate) =>
      candidate.botId === botId &&
      (candidate.status === "running" || candidate.status === "queued")
  );
  if (active) {
    const items = active.id ? itemsByRun?.get(active.id) : undefined;
    // Run items arrive only for the open conversation. Elsewhere the Bot is busy at
    // something unknown, which the working robot shows better than a thinking glyph.
    if (!items && scope !== activeChannel?.id) return "working";
    return activityAvatarMode(botActivityKind(items));
  }
  // Waiting on the person outranks the outcome of the run that asked.
  if (isWaitingOnUser(latestMessage, botId)) return "waiting";
  return settledAvatarMode(settled, now) ?? "idle";
}
