import type { BotView, ChannelMessageView, RunItemView, RunView } from "@openteam/contracts";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_COLOR_NAMES,
  resolveBotAvatarColorName,
} from "@openteam/contracts/bot-avatar";
import { thinkingActivity } from "./thinking-activity";

// Grok's text palette, rather than its brighter avatar fills.
const senderColors = {
  black: ["#3d3d3d", "#b7b7b7"],
  gray: ["#3d3d3d", "#b7b7b7"],
  brown: ["#734f2e", "#ae8968"],
  red: ["#c21d2e", "#ff5667"],
  orange: ["#c24e00", "#ff8838"],
  yellow: ["#824e00", "#ffaf38"],
  green: ["#00673a", "#38d591"],
  cyan: ["#008f7e", "#38cbba"],
  blue: ["#0c64c1", "#459ffe"],
  violet: ["#6e44c1", "#a97efe"],
  magenta: ["#c22476", "#ff5eb1"],
} as const;

export function groupSenderColors(color?: string): readonly [string, string] {
  const value = resolveBotAvatarColorName(color?.trim().toLowerCase() ?? "gray");
  const rgb = /^#[\da-f]{6}$/i.test(value)
    ? [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
    : null;
  if (!rgb) return senderColors.gray;
  // Legacy/custom hex colors use their nearest picker family, so their sender
  // label gets the same theme-aware contrast as the built-in colors.
  let nearest = 0,
    distance = Infinity;
  BOT_AVATAR_COLORS.forEach((candidate, index) => {
    const delta = [1, 3, 5].reduce(
      (sum, offset, component) =>
        sum + (Number.parseInt(candidate.slice(offset, offset + 2), 16) - rgb[component]!) ** 2,
      0
    );
    if (delta < distance) {
      nearest = index;
      distance = delta;
    }
  });
  return senderColors[BOT_AVATAR_COLOR_NAMES[nearest]!];
}

export function groupParticipantNames(names: readonly string[]): string {
  const displayed =
    names.length <= 3 ? names : [...names.slice(0, 2), `${names.length - 2} others`];
  return displayed.length < 2
    ? (displayed[0] ?? "Bot")
    : `${displayed.slice(0, -1).join(", ")} and ${displayed.at(-1)}`;
}

export type GroupActivity = {
  workers: BotView[];
  readers: BotView[];
  typing: boolean;
  text: string;
};

/** Like the reference, an active group turn reads until its first tool/send.
 * A completed tool keeps that turn committed to working through later reasoning.
 * Queued runs are not represented as readers: they have not started yet. */
export function groupChatActivity(
  runs: readonly RunView[],
  bots: ReadonlyMap<string, BotView>,
  itemsByRun: ReadonlyMap<string, RunItemView[]>,
  committedRunIds: ReadonlySet<string> = new Set()
): GroupActivity {
  const participants = new Map<
    string,
    { bot: BotView; phase: "reading" | "working" | "typing"; activity: string }
  >();
  for (const run of runs) {
    if (run.status !== "running" && run.status !== "queued") continue;
    const bot = bots.get(run.botId);
    if (!bot) continue;
    const items = itemsByRun.get(run.id) ?? [];
    const activity = thinkingActivity(items);
    const committed =
      committedRunIds.has(run.id) ||
      items.some((item) => ["tool", "command", "file_change"].includes(item.kind));
    const phase =
      activity === "Typing"
        ? "typing"
        : run.status === "running" && !committed && activity === "Thinking"
          ? "reading"
          : "working";
    // Multiple runs for one participant still occupy one seat.
    const previous = participants.get(bot.id);
    if (!previous || previous.phase === "reading" || phase === "typing")
      participants.set(bot.id, { bot, phase, activity });
  }
  const values = [...participants.values()];
  const workers = values.filter(({ phase }) => phase !== "reading").map(({ bot }) => bot);
  const readers = values.filter(({ phase }) => phase === "reading").map(({ bot }) => bot);
  const typing =
    workers.length > 0 &&
    values.filter(({ phase }) => phase !== "reading").every(({ phase }) => phase === "typing");
  const verb = workers.length === 1 ? "is" : "are";
  const singleWorkerActivity =
    workers.length === 1 ? values.find(({ phase }) => phase !== "reading")?.activity : undefined;
  const toolCaption =
    singleWorkerActivity && !["Thinking", "Working", "Typing"].includes(singleWorkerActivity)
      ? singleWorkerActivity
      : undefined;
  const working =
    toolCaption ??
    (workers.length
      ? `${groupParticipantNames(workers.map((bot) => bot.name))} ${verb} ${typing ? "typing" : "working"}`
      : "");
  const reading = readers.length
    ? `${groupParticipantNames(readers.map((bot) => bot.name))} ${readers.length === 1 ? "is" : "are"} reading`
    : "";
  return { workers, readers, typing, text: [working, reading].filter(Boolean).join(" · ") };
}

export function firstUnreadMessageId(
  messages: readonly ChannelMessageView[],
  through: string | null
): string | null {
  if (through === null || !/^\d+$/.test(through)) return null;
  const boundary = BigInt(through);
  return (
    messages.find(
      (message) =>
        message.sender === "agent" &&
        /^\d+$/.test(message.sequence) &&
        BigInt(message.sequence) > boundary
    )?.id ?? null
  );
}
