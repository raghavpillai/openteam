import { channelNotificationStates } from "@openteam/messaging";
import {
  ApiError,
  type ChannelClientState,
  type ChannelHistoryPage,
  type ChannelMessageContextView,
  CLIENT_CAPABILITIES,
  type ClientBootstrapView,
  type ClientRuntimeView,
  type ClientSnapshot,
  type ServerInferenceSettings,
  type Snapshot,
} from "@openteam/contracts";
import { Prisma, type PrismaClient } from "@openteam/db";
import { approvalViews } from "./approval-view";
import { serviceEffect } from "./service-utils";
import {
  channelUnreadCounts,
  type StoredChannelMessage,
  threadContextFor,
} from "./snapshot/message-queries";
import { clientBots, clientChannels } from "./snapshot/roster-queries";
import { RuntimeHealth } from "./snapshot/runtime-health";
import { channelViews, messageViews, roundViews, runViews, workspaceView } from "./snapshot/views";
import { subagentActivityView } from "./subagent/view";
import { toBotView } from "./view-mappers";

const DEFAULT_HISTORY_LIMIT = 100;

const MAX_HISTORY_LIMIT = 200;

const DEFAULT_CONTEXT_EXTENT = 50;

const MAX_CONTEXT_EXTENT = 100;

const EVENT_BATCH_SIZE = 500;

const MAX_RETAINED_EVENTS = 100_000;

export const CHANNEL_CLIENT_STATE_LIMITS = {
  channelRounds: 100,
  runs: 100,
  runItems: 1_000,
  approvals: 200,
  subagents: 100,
} as const;

export const normalizeHistoryLimit = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.trunc(value)))
    : DEFAULT_HISTORY_LIMIT;

export const normalizeMessageContextExtent = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(MAX_CONTEXT_EXTENT, Math.max(0, Math.trunc(value)))
    : DEFAULT_CONTEXT_EXTENT;

export const selectBoundedActivity = <T extends { id: string; createdAt: Date }>(
  current: readonly T[],
  recent: readonly T[],
  limit: number
): { items: T[]; truncated: boolean } => {
  const selected: T[] = [];
  const seen = new Set<string>();
  for (const item of [...current, ...recent]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (selected.length < limit) selected.push(item);
  }
  return {
    items: selected.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
    truncated: seen.size > limit,
  };
};

export class SnapshotService {
  private readonly runtimeHealth: RuntimeHealth;

  private clientInFlight: Promise<ClientSnapshot> | null = null;
  private bootstrapInFlight: Promise<ClientBootstrapView> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly workspaceRoot: string,
    private readonly computerUrl: string,
    private readonly isQueueReady: () => boolean | Promise<boolean>,
    private readonly runtimeProbeTimeoutMs = 2_500,
    private readonly inferenceSettings?: () => Promise<ServerInferenceSettings>,
    transcriptionStatus?: () => Promise<"configured" | "missing" | "invalid">
  ) {
    this.runtimeHealth = new RuntimeHealth(
      prisma,
      computerUrl,
      isQueueReady,
      runtimeProbeTimeoutMs,
      inferenceSettings,
      transcriptionStatus
    );
  }

  full = () =>
    serviceEffect(async (): Promise<Snapshot> => {
      const [
        bots,
        channels,
        channelMessages,
        channelRounds,
        messages,
        runs,
        runItems,
        approvals,
        subagentAttempts,
        cursor,
        runtime,
      ] = await Promise.all([
        this.prisma.bot.findMany({
          include: {
            conversation: true,
            channelMemberships: { include: { channel: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.channel.findMany({
          where: { archivedAt: null },
          include: { members: { orderBy: { ordinal: "asc" } } },
          orderBy: { updatedAt: "desc" },
        }),
        this.prisma.channelMessage.findMany({ orderBy: { sequence: "asc" } }),
        this.prisma.channelRound.findMany({ orderBy: { createdAt: "asc" } }),
        this.prisma.message.findMany({ orderBy: { createdAt: "asc" } }),
        this.prisma.run.findMany({ orderBy: { createdAt: "asc" } }),
        this.prisma.runItem.findMany({ orderBy: { createdAt: "asc" } }),
        this.prisma.approval.findMany({ orderBy: { createdAt: "asc" } }),
        this.prisma.subagentAttempt.findMany({
          include: {
            subagent: { select: { id: true, parentBotId: true, subagentType: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.event.findFirst({
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        }),
        this.runtimeHealth.runtimeStatus(),
      ]);
      const unreadCounts = await channelUnreadCounts(
        this.prisma,
        channels.map((channel) => channel.id)
      );
      return {
        cursor: cursor?.sequence.toString() ?? "0",
        workspace: workspaceView(this.workspaceRoot),
        bots: bots
          .filter((bot) => bot.conversation)
          .filter((bot) =>
            bot.channelMemberships.some((membership) => membership.channel.kind === "bot_dm")
          )
          .map(toBotView),
        channels: channelViews(
          channels,
          unreadCounts,
          await channelNotificationStates(
            this.prisma,
            channels.map((channel) => channel.id)
          )
        ),
        channelMessages: messageViews(channelMessages),
        channelRounds: roundViews(channelRounds),
        messages: messages.map((message) => ({
          ...message,
          createdAt: message.createdAt.toISOString(),
          updatedAt: message.updatedAt.toISOString(),
        })),
        runs: runViews(runs),
        runItems: runItems.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
        approvals: approvalViews(approvals, runs, subagentAttempts),
        subagents: subagentAttempts.map(subagentActivityView),
        runtime,
      } as Snapshot;
    });

  client = () => serviceEffect(() => this.sharedClientSnapshot());

  private async sharedClientSnapshot(): Promise<ClientSnapshot> {
    if (this.clientInFlight) return this.clientInFlight;
    this.clientInFlight = this.loadClientSnapshot().finally(() => {
      this.clientInFlight = null;
    });
    return this.clientInFlight;
  }

  private async loadClientSnapshot(): Promise<ClientSnapshot> {
    const [bots, channels, cursor, runtime] = await Promise.all([
      clientBots(this.prisma),
      clientChannels(this.prisma),
      this.prisma.event.findFirst({
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      }),
      this.runtimeStatusCached(),
    ]);
    const channelIds = channels.map((channel) => channel.id);
    const [channelMessages, channelRounds, runs, subagentAttempts, unreadCounts] =
      await Promise.all([
        this.prisma.channelMessage.findMany({
          where: { channelId: { in: channelIds } },
          orderBy: { sequence: "asc" },
        }),
        this.prisma.channelRound.findMany({
          where: { channelId: { in: channelIds } },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.run.findMany({
          where: { channelId: { in: channelIds } },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.subagentAttempt.findMany({
          where: { parentChannelId: { in: channelIds } },
          include: {
            subagent: { select: { id: true, parentBotId: true, subagentType: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
        channelUnreadCounts(this.prisma, channelIds),
      ]);
    const runIds = runs.map((run) => run.id);
    const approvalRunIds = [
      ...runIds,
      ...subagentAttempts.flatMap((attempt) => (attempt.childRunId ? [attempt.childRunId] : [])),
    ];
    const [runItems, approvals] = await Promise.all([
      this.prisma.runItem.findMany({
        where: { runId: { in: runIds }, kind: { notIn: ["agent_message", "reasoning"] } },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.approval.findMany({
        where: { runId: { in: approvalRunIds } },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      cursor: cursor?.sequence.toString() ?? "0",
      workspace: workspaceView(this.workspaceRoot),
      bots: bots
        .filter((bot) => bot.conversation)
        .filter((bot) =>
          bot.channelMemberships.some((membership) => membership.channel.kind === "bot_dm")
        )
        .map(toBotView),
      channels: channelViews(
        channels,
        unreadCounts,
        await channelNotificationStates(
          this.prisma,
          channels.map((channel) => channel.id)
        )
      ),
      channelMessages: messageViews(channelMessages),
      channelRounds: roundViews(channelRounds),
      runs: runViews(runs),
      runItems: runItems.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      approvals: approvalViews(approvals, runs, subagentAttempts),
      subagents: subagentAttempts.map(subagentActivityView),
      runtime,
    } as ClientSnapshot;
  }

  /**
   * Small, additive startup surface for clients that load channel history on
   * demand. The legacy full snapshot remains unchanged for rolling upgrades.
   */
  bootstrap = () => serviceEffect(() => this.sharedClientBootstrap());

  private async sharedClientBootstrap(): Promise<ClientBootstrapView> {
    if (this.bootstrapInFlight) return this.bootstrapInFlight;
    this.bootstrapInFlight = this.loadClientBootstrap().finally(() => {
      this.bootstrapInFlight = null;
    });
    return this.bootstrapInFlight;
  }

  private async loadClientBootstrap(): Promise<ClientBootstrapView> {
    const startCursor = await this.prisma.event.findFirst({
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const [bots, channels, runtime] = await Promise.all([
      clientBots(this.prisma),
      clientChannels(this.prisma),
      this.runtimeStatusCached(),
    ]);
    const channelIds = channels.map((channel) => channel.id);
    const [latestMessages, activeRuns, channelRounds, subagentAttempts, unreadCounts] =
      await Promise.all([
        channelIds.length === 0
          ? Promise.resolve([])
          : this.prisma.$queryRaw<StoredChannelMessage[]>(Prisma.sql`
              SELECT latest.*
              FROM unnest(${channelIds}::uuid[]) AS requested("channelId")
              CROSS JOIN LATERAL (
                SELECT
                  message."id",
                  message."clientId",
                  message."sequence",
                  message."channelId",
                  message."sender",
                  message."senderBotId",
                  message."sourceRunId",
                  message."content",
                  message."metadata",
                  message."createdAt"
                FROM "ChannelMessage" AS message
                WHERE message."channelId" = requested."channelId"
                ORDER BY message."sequence" DESC
                LIMIT 1
              ) AS latest
              ORDER BY latest."sequence" ASC
            `),
        this.prisma.run.findMany({
          where: {
            channelId: { in: channelIds },
            status: { in: ["queued", "running", "waiting_approval"] },
          },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.channelRound.findMany({
          where: {
            channelId: { in: channelIds },
            status: { in: ["queued", "running"] },
          },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.subagentAttempt.findMany({
          where: {
            parentChannelId: { in: channelIds },
            status: { in: ["provisioning", "queued", "running"] },
          },
          include: {
            subagent: { select: { id: true, parentBotId: true, subagentType: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
        channelUnreadCounts(this.prisma, channelIds),
      ]);
    const approvalRunIds = [
      ...activeRuns.map((run) => run.id),
      ...subagentAttempts.flatMap((attempt) => (attempt.childRunId ? [attempt.childRunId] : [])),
    ];
    const approvals = await this.prisma.approval.findMany({
      where: {
        runId: { in: approvalRunIds },
        status: "pending",
      },
      orderBy: { createdAt: "asc" },
    });
    return {
      cursor: startCursor?.sequence.toString() ?? "0",
      workspace: workspaceView(this.workspaceRoot),
      bots: bots
        .filter((bot) => bot.conversation)
        .filter((bot) =>
          bot.channelMemberships.some((membership) => membership.channel.kind === "bot_dm")
        )
        .map(toBotView),
      channels: channelViews(
        channels,
        unreadCounts,
        await channelNotificationStates(
          this.prisma,
          channels.map((channel) => channel.id)
        )
      ),
      latestMessages: messageViews(latestMessages),
      activeRuns: runViews(activeRuns),
      pendingApprovals: approvalViews(approvals, activeRuns, subagentAttempts),
      channelRounds: roundViews(channelRounds),
      subagents: subagentAttempts.map(subagentActivityView),
      runtime,
      capabilities: CLIENT_CAPABILITIES,
    };
  }

  history = (channelId: string, beforeSequence: bigint | null, requestedLimit: number) =>
    serviceEffect(async (): Promise<ChannelHistoryPage> => {
      const channel = await this.prisma.channel.findFirst({
        where: {
          id: channelId,
          archivedAt: null,
          members: {
            some: {
              bot: {
                status: { not: "archived" },
                subagentIdentity: { is: null },
              },
            },
          },
        },
        select: { id: true },
      });
      if (!channel) throw new ApiError(404, "channel_not_found", "Channel not found");
      const limit = normalizeHistoryLimit(requestedLimit);
      const [rows, revision] = await Promise.all([
        this.prisma.channelMessage.findMany({
          where: {
            channelId,
            ...(beforeSequence === null ? {} : { sequence: { lt: beforeSequence } }),
          },
          orderBy: { sequence: "desc" },
          take: limit + 1,
        }),
        this.prisma.event.findFirst({
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        }),
      ]);
      const hasMore = rows.length > limit;
      const messages = rows.slice(0, limit).reverse();
      const threadContext = await threadContextFor(this.prisma, channelId, messages);
      return {
        channelId,
        messages: messageViews(messages),
        threadContext: messageViews(threadContext.messages),
        threadContextTruncated: threadContext.truncated,
        beforeSequence: messages[0]?.sequence.toString() ?? null,
        hasMore,
        revision: revision?.sequence.toString() ?? "0",
      };
    });

  /**
   * Resolve a search hit without downloading the channel's lifetime history.
   * Both sides are independently capped and the returned edge sequences plug
   * directly into the existing history cursor model.
   */
  messageContext = (messageId: string, requestedBefore: number, requestedAfter: number) =>
    serviceEffect(async (): Promise<ChannelMessageContextView> => {
      const target = await this.prisma.channelMessage.findFirst({
        where: {
          id: messageId,
          channel: {
            archivedAt: null,
            members: {
              some: {
                bot: {
                  status: { not: "archived" },
                  subagentIdentity: { is: null },
                },
              },
            },
          },
        },
      });
      if (!target) throw new ApiError(404, "message_not_found", "Message was not found");

      const beforeLimit = normalizeMessageContextExtent(requestedBefore);
      const afterLimit = normalizeMessageContextExtent(requestedAfter);
      const [beforeRows, afterRows, revision] = await Promise.all([
        this.prisma.channelMessage.findMany({
          where: { channelId: target.channelId, sequence: { lt: target.sequence } },
          orderBy: { sequence: "desc" },
          take: beforeLimit + 1,
        }),
        this.prisma.channelMessage.findMany({
          where: { channelId: target.channelId, sequence: { gt: target.sequence } },
          orderBy: { sequence: "asc" },
          take: afterLimit + 1,
        }),
        this.prisma.event.findFirst({
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        }),
      ]);
      const messages = [
        ...beforeRows.slice(0, beforeLimit).reverse(),
        target,
        ...afterRows.slice(0, afterLimit),
      ];
      const threadContext = await threadContextFor(this.prisma, target.channelId, messages);
      return {
        channelId: target.channelId,
        targetMessageId: target.id,
        messages: messageViews(messages),
        threadContext: messageViews(threadContext.messages),
        threadContextTruncated: threadContext.truncated,
        beforeSequence: (messages[0] ?? target).sequence.toString(),
        afterSequence: (messages.at(-1) ?? target).sequence.toString(),
        hasMoreBefore: beforeRows.length > beforeLimit,
        hasMoreAfter: afterRows.length > afterLimit,
        revision: revision?.sequence.toString() ?? "0",
      };
    });

  channelState = (channelId: string) =>
    serviceEffect(async (): Promise<ChannelClientState> => {
      const channel = await this.prisma.channel.findFirst({
        where: {
          id: channelId,
          archivedAt: null,
          members: {
            some: {
              bot: {
                status: { not: "archived" },
                subagentIdentity: { is: null },
              },
            },
          },
        },
        select: { id: true },
      });
      if (!channel) throw new ApiError(404, "channel_not_found", "Channel not found");
      const roundLimit = CHANNEL_CLIENT_STATE_LIMITS.channelRounds;
      const runLimit = CHANNEL_CLIENT_STATE_LIMITS.runs;
      const subagentLimit = CHANNEL_CLIENT_STATE_LIMITS.subagents;
      const [
        currentRounds,
        recentRounds,
        currentRuns,
        recentRuns,
        currentSubagents,
        recentSubagents,
        revision,
      ] = await Promise.all([
        this.prisma.channelRound.findMany({
          where: { channelId, status: { in: ["queued", "running"] } },
          orderBy: { createdAt: "desc" },
          take: roundLimit + 1,
        }),
        this.prisma.channelRound.findMany({
          where: { channelId, status: { notIn: ["queued", "running"] } },
          orderBy: { createdAt: "desc" },
          take: roundLimit + 1,
        }),
        this.prisma.run.findMany({
          where: { channelId, status: { in: ["queued", "running", "waiting_approval"] } },
          orderBy: { createdAt: "desc" },
          take: runLimit + 1,
        }),
        this.prisma.run.findMany({
          where: {
            channelId,
            status: { notIn: ["queued", "running", "waiting_approval"] },
          },
          orderBy: { createdAt: "desc" },
          take: runLimit + 1,
        }),
        this.prisma.subagentAttempt.findMany({
          where: {
            parentChannelId: channelId,
            status: { in: ["provisioning", "queued", "running"] },
          },
          include: {
            subagent: { select: { id: true, parentBotId: true, subagentType: true } },
          },
          orderBy: { createdAt: "desc" },
          take: subagentLimit + 1,
        }),
        this.prisma.subagentAttempt.findMany({
          where: {
            parentChannelId: channelId,
            status: { notIn: ["provisioning", "queued", "running"] },
          },
          include: {
            subagent: { select: { id: true, parentBotId: true, subagentType: true } },
          },
          orderBy: { createdAt: "desc" },
          take: subagentLimit + 1,
        }),
        this.prisma.event.findFirst({
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        }),
      ]);
      const rounds = selectBoundedActivity(currentRounds, recentRounds, roundLimit);
      const runs = selectBoundedActivity(currentRuns, recentRuns, runLimit);
      const subagentAttempts = selectBoundedActivity(
        currentSubagents,
        recentSubagents,
        subagentLimit
      );
      const runIds = runs.items.map((run) => run.id);
      const currentRunIds = new Set(currentRuns.map((run) => run.id));
      const selectedCurrentRunIds = runIds.filter((runId) => currentRunIds.has(runId));
      const selectedRecentRunIds = runIds.filter((runId) => !currentRunIds.has(runId));
      const approvalRunIds = [
        ...runIds,
        ...subagentAttempts.items.flatMap((attempt) =>
          attempt.childRunId ? [attempt.childRunId] : []
        ),
      ];
      const runItemLimit = CHANNEL_CLIENT_STATE_LIMITS.runItems;
      const approvalLimit = CHANNEL_CLIENT_STATE_LIMITS.approvals;
      const [currentRunItems, recentRunItems, pendingApprovals, recentApprovals] =
        await Promise.all([
          this.prisma.runItem.findMany({
            where: {
              runId: { in: selectedCurrentRunIds },
              kind: { notIn: ["agent_message", "reasoning"] },
            },
            orderBy: { createdAt: "desc" },
            take: runItemLimit + 1,
          }),
          this.prisma.runItem.findMany({
            where: {
              runId: { in: selectedRecentRunIds },
              kind: { notIn: ["agent_message", "reasoning"] },
            },
            orderBy: { createdAt: "desc" },
            take: runItemLimit + 1,
          }),
          this.prisma.approval.findMany({
            where: { runId: { in: approvalRunIds }, status: "pending" },
            orderBy: { createdAt: "desc" },
            take: approvalLimit + 1,
          }),
          this.prisma.approval.findMany({
            where: { runId: { in: approvalRunIds }, status: { not: "pending" } },
            orderBy: { createdAt: "desc" },
            take: approvalLimit + 1,
          }),
        ]);
      const runItems = selectBoundedActivity(currentRunItems, recentRunItems, runItemLimit);
      const approvals = selectBoundedActivity(pendingApprovals, recentApprovals, approvalLimit);
      return {
        channelId,
        revision: revision?.sequence.toString() ?? "0",
        channelRounds: roundViews(rounds.items),
        runs: runViews(runs.items),
        runItems: runItems.items.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })) as ClientSnapshot["runItems"],
        approvals: approvalViews(approvals.items, runs.items, subagentAttempts.items),
        subagents: subagentAttempts.items.map(subagentActivityView),
        truncated: {
          channelRounds: rounds.truncated,
          runs: runs.truncated,
          runItems: runItems.truncated,
          approvals: approvals.truncated,
          subagents: subagentAttempts.truncated,
        },
      };
    });

  clientRuntime = () =>
    serviceEffect(
      async (): Promise<ClientRuntimeView> => ({ runtime: await this.runtimeStatusCached() })
    );

  health = () => serviceEffect(() => this.runtimeStatusCached());

  async eventWindowAfter(sequence: bigint, requestedLimit = EVENT_BATCH_SIZE) {
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(EVENT_BATCH_SIZE, Math.max(1, Math.trunc(requestedLimit)))
      : EVENT_BATCH_SIZE;
    const [bounds, events] = await Promise.all([
      this.prisma.event.aggregate({
        _min: { sequence: true },
        _max: { sequence: true },
      }),
      this.prisma.event.findMany({
        where: { sequence: { gt: sequence } },
        orderBy: { sequence: "asc" },
        take: limit,
      }),
    ]);
    const oldest = bounds._min.sequence;
    const latest = bounds._max.sequence;
    return {
      oldest,
      latest,
      cursorExpired: sequence > 0n && oldest !== null && sequence < oldest - 1n,
      cursorAhead: sequence > 0n && (latest === null || sequence > latest),
      hasMore: events.length === limit,
      events: events.map((event) => ({
        sequence: event.sequence.toString(),
        topic: event.topic,
        entityId: event.entityId,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  async eventsAfter(sequence: bigint) {
    return (await this.eventWindowAfter(sequence)).events;
  }

  /** Retain a bounded replay window; stale clients are sent snapshot.required. */
  async pruneEvents(): Promise<number> {
    return this.prisma.$executeRaw`
      WITH retention_floor AS (
        SELECT "sequence"
        FROM "Event"
        ORDER BY "sequence" DESC
        OFFSET ${MAX_RETAINED_EVENTS - 1}
        LIMIT 1
      )
      DELETE FROM "Event"
      WHERE "sequence" < (SELECT "sequence" FROM retention_floor)
    `;
  }

  private async runtimeStatusCached(): Promise<Snapshot["runtime"]> {
    return this.runtimeHealth.runtimeStatusCached();
  }
}
export { MAX_THREAD_CONTEXT_MESSAGES } from "./snapshot/message-queries";
