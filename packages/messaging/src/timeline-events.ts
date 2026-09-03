import type { Prisma } from "@openteam/db";

export type AutomationChangedAction = "created" | "updated" | "enabled" | "disabled" | "deleted";

export type AgentTimelineEvent =
  | { type: "name-changed"; from: string; to: string }
  | {
      type: "automation-changed";
      action: AutomationChangedAction;
      automationId: string;
      automationName: string;
    };

export interface TimelineEventWakeHost {
  isTimelineSessionActive?(botId: string): Promise<boolean>;
  enqueueWake(
    tx: Prisma.TransactionClient,
    input: {
      botId: string;
      channelId: string;
      origin: "event";
      type: string;
      content: string;
      clientId: string;
      priority: number;
      availableAt?: Date;
      occurredAt?: Date;
      timeZone?: string | null;
      wrapUserContent?: boolean;
    }
  ): Promise<unknown>;
}

const AUTOMATION_ACTION_VERB: Record<AutomationChangedAction, string> = {
  created: "Created",
  updated: "Updated",
  enabled: "Enabled",
  disabled: "Disabled",
  deleted: "Deleted",
};

export const describeAgentTimelineEvent = (event: AgentTimelineEvent): string => {
  if (event.type === "name-changed") return `Renamed to ${event.to}`;
  return `${AUTOMATION_ACTION_VERB[event.action]} routine ${JSON.stringify(event.automationName)}`;
};

export const buildTimelineEventWakePrompt = (event: AgentTimelineEvent): string =>
  [
    "[SAND_HIDDEN_PROMPT]",
    "[event] Something about this conversation just changed.",
    "This is a system event recorded in your timeline, not a message typed by the user.",
    `- ${describeAgentTimelineEvent(event)}`,
    "Acknowledge it with SendToUser only if that helps the user; otherwise finish silently.",
  ].join("\n");

/**
 * Grok-compatible timeline mutation delivery. The visible event is durable, but
 * the hidden background tap is deliberately lossy while the agent is running.
 * Group sessions never use this path.
 */
export const appendAgentTimelineEvent = async (
  tx: Prisma.TransactionClient,
  host: TimelineEventWakeHost,
  input: {
    botId: string;
    clientId: string;
    event: AgentTimelineEvent;
    occurredAt?: Date;
    timeZone?: string | null;
  }
): Promise<{ appended: boolean; woke: boolean }> => {
  if (host.isTimelineSessionActive && !(await host.isTimelineSessionActive(input.botId))) {
    return { appended: false, woke: false };
  }
  const channel = await tx.channel.findUnique({
    where: { directKey: `bot:${input.botId}` },
    select: { id: true, archivedAt: true },
  });
  if (!channel || channel.archivedAt) return { appended: false, woke: false };

  const occurredAt = input.occurredAt ?? new Date();
  await tx.channelMessage.create({
    data: {
      channelId: channel.id,
      clientId: `timeline:${input.clientId}`,
      sender: "system",
      content: "",
      metadata: { type: "event", event: input.event },
      createdAt: occurredAt,
    },
  });

  const [bot, lease] = await Promise.all([
    tx.bot.findUnique({ where: { id: input.botId }, select: { status: true } }),
    tx.botRunLease.findUnique({ where: { botId: input.botId }, select: { runId: true } }),
  ]);
  if (bot?.status !== "active" || lease) return { appended: true, woke: false };

  await host.enqueueWake(tx, {
    botId: input.botId,
    channelId: channel.id,
    origin: "event",
    type: "timeline.event",
    content: buildTimelineEventWakePrompt(input.event),
    clientId: `timeline-wake:${input.clientId}`,
    priority: 100,
    availableAt: new Date(occurredAt.getTime() + 75),
    occurredAt,
    timeZone: input.timeZone,
    wrapUserContent: false,
  });
  return { appended: true, woke: true };
};
