import { resolve } from "node:path";
import {
  ApiError,
  type ChannelClientState,
  type ChannelHistoryPage,
  type ChannelMessageContextView,
  CLIENT_CAPABILITIES,
  type ClientBootstrapView,
  type ClientRuntimeView,
  type ClientSnapshot,
  type Snapshot,
} from "@openbot/contracts";
import { Prisma, type PrismaClient } from "@openbot/db";
import { Effect } from "effect";
import { approvalViews } from "./approval-view";
import { subagentActivityView } from "./subagent-view";
import { toBotView } from "./view-mappers";

const COMPUTER_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 200;
const DEFAULT_CONTEXT_EXTENT = 50;
const MAX_CONTEXT_EXTENT = 100;
export const MAX_THREAD_CONTEXT_MESSAGES = 100;
const EVENT_BATCH_SIZE = 500;
const MAX_RETAINED_EVENTS = 100_000;

export const CHANNEL_CLIENT_STATE_LIMITS = {
  channelRounds: 100,
  runs: 100,
  runItems: 1_000,
  approvals: 200,
  subagents: 100,
} as const;

type StoredChannelMessage = {
  id: string;
  clientId?: string | null;
  sequence: bigint;
  channelId: string;
  sender: string;
  senderBotId: string | null;
  sourceRunId: string | null;
  content: string;
  metadata: unknown;
  createdAt: Date;
};

type StoredThreadContextMessage = StoredChannelMessage & {
  traversalDepth: number;
  seedOrder: number;
};

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
  private runtimeCache: { expiresAt: number; value: Snapshot["runtime"] } | null = null;
  private runtimeInFlight: Promise<Snapshot["runtime"]> | null = null;
  private clientInFlight: Promise<ClientSnapshot> | null = null;
  private bootstrapInFlight: Promise<ClientBootstrapView> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly workspaceRoot: string,
    private readonly computerUrl: string,
    private readonly isQueueReady: () => boolean
  ) {}

  full = () =>
    Effect.tryPromise({
      try: async (): Promise<Snapshot> => {
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
          this.runtimeStatus(),
        ]);
        const unreadCounts = await this.channelUnreadCounts(channels.map((channel) => channel.id));
        return {
          cursor: cursor?.sequence.toString() ?? "0",
          workspace: this.workspaceView(),
          bots: bots
            .filter((bot) => bot.conversation)
            .filter((bot) =>
              bot.channelMemberships.some((membership) => membership.channel.kind === "bot_dm")
            )
            .map(toBotView),
          channels: this.channelViews(channels, unreadCounts),
          channelMessages: this.messageViews(channelMessages),
          channelRounds: this.roundViews(channelRounds),
          messages: messages.map((message) => ({
            ...message,
            createdAt: message.createdAt.toISOString(),
            updatedAt: message.updatedAt.toISOString(),
          })),
          runs: this.runViews(runs),
          runItems: runItems.map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
            updatedAt: item.updatedAt.toISOString(),
          })),
          approvals: approvalViews(approvals, runs, subagentAttempts),
          subagents: subagentAttempts.map(subagentActivityView),
          runtime,
        } as Snapshot;
      },
      catch: SnapshotService.toError,
    });

  client = () =>
    Effect.tryPromise({
      try: () => this.sharedClientSnapshot(),
      catch: SnapshotService.toError,
    });

  private async sharedClientSnapshot(): Promise<ClientSnapshot> {
    if (this.clientInFlight) return this.clientInFlight;
    this.clientInFlight = this.loadClientSnapshot().finally(() => {
      this.clientInFlight = null;
    });
    return this.clientInFlight;
  }

  private async loadClientSnapshot(): Promise<ClientSnapshot> {
    const [bots, channels, cursor, runtime] = await Promise.all([
      this.prisma.bot.findMany({
        where: {
          status: { not: "archived" },
          subagentIdentity: { is: null },
        },
        include: {
          conversation: true,
          channelMemberships: {
            where: { channel: { archivedAt: null } },
            include: { channel: true },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.channel.findMany({
        where: {
          archivedAt: null,
          members: {
            some: {
              bot: { status: { not: "archived" }, subagentIdentity: { is: null } },
            },
          },
        },
        include: { members: { orderBy: { ordinal: "asc" } } },
        orderBy: { updatedAt: "desc" },
      }),
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
        this.channelUnreadCounts(channelIds),
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
      workspace: this.workspaceView(),
      bots: bots
        .filter((bot) => bot.conversation)
        .filter((bot) =>
          bot.channelMemberships.some((membership) => membership.channel.kind === "bot_dm")
        )
        .map(toBotView),
      channels: this.channelViews(channels, unreadCounts),
      channelMessages: this.messageViews(channelMessages),
      channelRounds: this.roundViews(channelRounds),
      runs: this.runViews(runs),
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
  bootstrap = () =>
    Effect.tryPromise({
      try: () => this.sharedClientBootstrap(),
      catch: SnapshotService.toError,
    });

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
      this.prisma.bot.findMany({
        where: {
          status: { not: "archived" },
          subagentIdentity: { is: null },
        },
        include: {
          conversation: true,
          channelMemberships: {
            where: { channel: { archivedAt: null } },
            include: { channel: true },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.channel.findMany({
        where: {
          archivedAt: null,
          members: {
            some: {
              bot: { status: { not: "archived" }, subagentIdentity: { is: null } },
            },
          },
        },
        include: { members: { orderBy: { ordinal: "asc" } } },
        orderBy: { updatedAt: "desc" },
      }),
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
        this.channelUnreadCounts(channelIds),
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
      workspace: this.workspaceView(),
      bots: bots
        .filter((bot) => bot.conversation)
        .filter((bot) =>
          bot.channelMemberships.some((membership) => membership.channel.kind === "bot_dm")
        )
        .map(toBotView),
      channels: this.channelViews(channels, unreadCounts),
      latestMessages: this.messageViews(latestMessages),
      activeRuns: this.runViews(activeRuns),
      pendingApprovals: approvalViews(approvals, activeRuns, subagentAttempts),
      channelRounds: this.roundViews(channelRounds),
      subagents: subagentAttempts.map(subagentActivityView),
      runtime,
      capabilities: CLIENT_CAPABILITIES,
    };
  }

  history = (channelId: string, beforeSequence: bigint | null, requestedLimit: number) =>
    Effect.tryPromise({
      try: async (): Promise<ChannelHistoryPage> => {
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
        const threadContext = await this.threadContextFor(channelId, messages);
        return {
          channelId,
          messages: this.messageViews(messages),
          threadContext: this.messageViews(threadContext.messages),
          threadContextTruncated: threadContext.truncated,
          beforeSequence: messages[0]?.sequence.toString() ?? null,
          hasMore,
          revision: revision?.sequence.toString() ?? "0",
        };
      },
      catch: SnapshotService.toError,
    });

  /**
   * Resolve a search hit without downloading the channel's lifetime history.
   * Both sides are independently capped and the returned edge sequences plug
   * directly into the existing history cursor model.
   */
  messageContext = (messageId: string, requestedBefore: number, requestedAfter: number) =>
    Effect.tryPromise({
      try: async (): Promise<ChannelMessageContextView> => {
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
        const threadContext = await this.threadContextFor(target.channelId, messages);
        return {
          channelId: target.channelId,
          targetMessageId: target.id,
          messages: this.messageViews(messages),
          threadContext: this.messageViews(threadContext.messages),
          threadContextTruncated: threadContext.truncated,
          beforeSequence: (messages[0] ?? target).sequence.toString(),
          afterSequence: (messages.at(-1) ?? target).sequence.toString(),
          hasMoreBefore: beforeRows.length > beforeLimit,
          hasMoreAfter: afterRows.length > afterLimit,
          revision: revision?.sequence.toString() ?? "0",
        };
      },
      catch: SnapshotService.toError,
    });

  channelState = (channelId: string) =>
    Effect.tryPromise({
      try: async (): Promise<ChannelClientState> => {
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
          channelRounds: this.roundViews(rounds.items),
          runs: this.runViews(runs.items),
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
      },
      catch: SnapshotService.toError,
    });

  clientRuntime = () =>
    Effect.tryPromise({
      try: async (): Promise<ClientRuntimeView> => ({ runtime: await this.runtimeStatusCached() }),
      catch: SnapshotService.toError,
    });

  health = () =>
    Effect.tryPromise({
      try: () => this.runtimeStatusCached(),
      catch: SnapshotService.toError,
    });

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

  private async threadContextFor(
    channelId: string,
    messages: readonly StoredChannelMessage[]
  ): Promise<{ messages: StoredChannelMessage[]; truncated: boolean }> {
    const replyTarget = (message: StoredChannelMessage): string | null => {
      if (
        !message.metadata ||
        typeof message.metadata !== "object" ||
        Array.isArray(message.metadata)
      ) {
        return null;
      }
      const metadata = message.metadata as Record<string, unknown>;
      return metadata.branched === true && typeof metadata.replyTo === "string"
        ? metadata.replyTo
        : null;
    };

    const knownIds = new Set(messages.map((message) => message.id));
    const pendingIds = new Set(
      messages.flatMap((message) => {
        const targetId = replyTarget(message);
        return targetId && !knownIds.has(targetId) ? [targetId] : [];
      })
    );
    if (pendingIds.size === 0) return { messages: [], truncated: false };

    // Every seed has at most one parent. Capping each path therefore bounds
    // the complete walk to page-size * limit, while the extra returned row is
    // only a truncation probe. Keeping the walk in PostgreSQL eliminates up to
    // 100 sequential round trips for a deep branch.
    const rows = await this.prisma.$queryRaw<StoredThreadContextMessage[]>(Prisma.sql`
      WITH RECURSIVE
      input AS (
        SELECT
          ${channelId}::uuid AS "channelId",
          ${[...knownIds]}::uuid[] AS "knownIds"
      ),
      seed("id", "seedOrder") AS (
        SELECT
          CASE
            WHEN seed."id" ~ '^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$'
              THEN seed."id"::uuid
            ELSE NULL::uuid
          END,
          seed."ordinality"::int
        FROM unnest(${[...pendingIds]}::text[]) WITH ORDINALITY AS seed("id", "ordinality")
      ),
      ancestor AS (
        SELECT
          message."id",
          message."sequence",
          message."channelId",
          message."sender",
          message."senderBotId",
          message."sourceRunId",
          message."content",
          message."metadata",
          message."createdAt",
          1 AS "traversalDepth",
          seed."seedOrder",
          CASE
            WHEN message."metadata" -> 'branched' = 'true'::jsonb
              AND jsonb_typeof(message."metadata" -> 'replyTo') = 'string'
              AND message."metadata" ->> 'replyTo'
                ~ '^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$'
              THEN (message."metadata" ->> 'replyTo')::uuid
            ELSE NULL::uuid
          END AS "replyToId",
          ARRAY[message."id"] AS path
        FROM seed
        CROSS JOIN input
        INNER JOIN "ChannelMessage" AS message
          ON message."channelId" = input."channelId"
          AND message."id" = seed."id"
        WHERE NOT (message."id" = ANY(input."knownIds"))

        UNION ALL

        SELECT
          parent."id",
          parent."sequence",
          parent."channelId",
          parent."sender",
          parent."senderBotId",
          parent."sourceRunId",
          parent."content",
          parent."metadata",
          parent."createdAt",
          current."traversalDepth" + 1,
          current."seedOrder",
          CASE
            WHEN parent."metadata" -> 'branched' = 'true'::jsonb
              AND jsonb_typeof(parent."metadata" -> 'replyTo') = 'string'
              AND parent."metadata" ->> 'replyTo'
                ~ '^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$'
              THEN (parent."metadata" ->> 'replyTo')::uuid
            ELSE NULL::uuid
          END,
          current.path || parent."id"
        FROM ancestor AS current
        CROSS JOIN input
        INNER JOIN "ChannelMessage" AS parent
          ON parent."channelId" = input."channelId"
          AND parent."id" = current."replyToId"
        WHERE current."traversalDepth" < ${MAX_THREAD_CONTEXT_MESSAGES + 1}
          AND NOT (parent."id" = ANY(input."knownIds"))
          AND NOT (parent."id" = ANY(current.path))
      ),
      ranked AS (
        SELECT
          ancestor.*,
          row_number() OVER (
            PARTITION BY ancestor."id"
            ORDER BY ancestor."traversalDepth" ASC, ancestor."seedOrder" ASC
          ) AS "duplicateRank"
        FROM ancestor
      )
      SELECT
        ranked."id",
        ranked."sequence",
        ranked."channelId",
        ranked."sender",
        ranked."senderBotId",
        ranked."sourceRunId",
        ranked."content",
        ranked."metadata",
        ranked."createdAt",
        ranked."traversalDepth",
        ranked."seedOrder"
      FROM ranked
      WHERE ranked."duplicateRank" = 1
      ORDER BY
        ranked."traversalDepth" ASC,
        ranked."seedOrder" ASC,
        ranked."sequence" ASC,
        ranked."id" ASC
      LIMIT ${MAX_THREAD_CONTEXT_MESSAGES + 1}
    `);
    const context = rows.slice(0, MAX_THREAD_CONTEXT_MESSAGES);

    return {
      messages: context.sort((left, right) =>
        left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0
      ),
      truncated: rows.length > MAX_THREAD_CONTEXT_MESSAGES,
    };
  }

  private workspaceView() {
    return {
      root: this.workspaceRoot,
      sharedDirectory: resolve(this.workspaceRoot, "shared"),
      botsDirectory: resolve(this.workspaceRoot, "bots"),
      projectsDirectory: resolve(this.workspaceRoot, "projects"),
    };
  }

  private channelViews<
    T extends Array<{
      id: string;
      kind: string;
      name: string;
      description: string;
      avatarPath: string | null;
      directKey: string | null;
      workingDirectory: string | null;
      hiddenFromSidebar: boolean;
      members: Array<{ botId: string; ordinal: number }>;
      createdAt: Date;
      updatedAt: Date;
    }>,
  >(channels: T, unreadCounts: ReadonlyMap<string, number>) {
    return channels.map((channel) => ({
      id: channel.id,
      kind: channel.kind as Snapshot["channels"][number]["kind"],
      name: channel.name,
      description: channel.description,
      hasAvatar: Boolean(channel.avatarPath),
      directKey: channel.directKey,
      workingDirectory: channel.workingDirectory,
      hiddenFromSidebar: channel.hiddenFromSidebar,
      members: channel.members.map((member) => ({ botId: member.botId, ordinal: member.ordinal })),
      unreadCount: unreadCounts.get(channel.id) ?? 0,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
    }));
  }

  private async channelUnreadCounts(channelIds: readonly string[]): Promise<Map<string, number>> {
    if (channelIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ channelId: string; unreadCount: number }>>(
      Prisma.sql`
        SELECT
          message."channelId" AS "channelId",
          COUNT(*)::int AS "unreadCount"
        FROM "ChannelMessage" AS message
        LEFT JOIN "ChannelReadState" AS state
          ON state."channelId" = message."channelId"
        WHERE message."channelId" = ANY(${channelIds}::uuid[])
          AND message."sender" = 'agent'
          AND message."sequence" > COALESCE(state."lastReadSequence", 0)
          AND NOT (COALESCE(message."metadata", '{}'::jsonb) ? 'fromAgent')
          AND NOT (COALESCE(message."metadata", '{}'::jsonb) ? 'toAgent')
        GROUP BY message."channelId"
      `
    );
    return new Map(rows.map((row) => [row.channelId, Number(row.unreadCount)]));
  }

  private messageViews<
    T extends Array<{
      id: string;
      clientId?: string | null;
      sequence: bigint;
      channelId: string;
      sender: string;
      senderBotId: string | null;
      sourceRunId: string | null;
      content: string;
      metadata: unknown;
      createdAt: Date;
    }>,
  >(messages: T) {
    return messages.map((message) => ({
      id: message.id,
      ...(typeof message.clientId === "string" ? { clientId: message.clientId } : {}),
      sequence: message.sequence.toString(),
      channelId: message.channelId,
      sender: message.sender as Snapshot["channelMessages"][number]["sender"],
      senderBotId: message.senderBotId,
      sourceRunId: message.sourceRunId,
      content: message.content,
      metadata: message.metadata as Snapshot["channelMessages"][number]["metadata"],
      createdAt: message.createdAt.toISOString(),
    }));
  }

  private roundViews<
    T extends Array<{
      id: string;
      channelId: string;
      triggerMessageId: string;
      rootMessageId: string;
      roundIndex: number;
      memberTurnOffset: number;
      initiatorBotId: string | null;
      status: string;
      currentOrdinal: number;
      createdAt: Date;
      completedAt: Date | null;
    }>,
  >(rounds: T) {
    return rounds.map((round) => ({
      id: round.id,
      channelId: round.channelId,
      triggerMessageId: round.triggerMessageId,
      rootMessageId: round.rootMessageId,
      roundIndex: round.roundIndex,
      memberTurnOffset: round.memberTurnOffset,
      initiatorBotId: round.initiatorBotId,
      status: round.status as Snapshot["channelRounds"][number]["status"],
      currentOrdinal: round.currentOrdinal,
      createdAt: round.createdAt.toISOString(),
      completedAt: round.completedAt?.toISOString() ?? null,
    }));
  }

  private runViews<T extends Array<{ createdAt: Date; updatedAt: Date }>>(
    runs: T
  ): Snapshot["runs"] {
    return runs.map((run) => ({
      ...run,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    })) as Snapshot["runs"];
  }

  private async runtimeStatus(): Promise<Snapshot["runtime"]> {
    let computer: Snapshot["runtime"]["computer"] = "unavailable";
    let inference: Snapshot["runtime"]["inference"] = "unavailable";
    try {
      const response = await fetch(`${this.computerUrl}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      const body = (await response.json()) as {
        status?: string;
        inference?: { ready?: boolean; authenticated?: boolean };
      };
      computer = response.ok && body.status === "ready" ? "ready" : "unavailable";
      inference = body.inference?.ready
        ? body.inference.authenticated
          ? "ready"
          : "missing"
        : "unavailable";
      await this.prisma.computer.update({
        where: { id: COMPUTER_ID },
        data: {
          status: computer === "ready" ? "ready" : "unavailable",
          lastSeenAt: new Date(),
        },
      });
    } catch {
      // Snapshots remain usable while the runtime is down.
    }
    return {
      server: computer === "ready" ? "ready" : "degraded",
      database: "ready",
      queue: this.isQueueReady() ? "ready" : "unavailable",
      computer,
      inference,
    };
  }

  private async runtimeStatusCached(): Promise<Snapshot["runtime"]> {
    if (this.runtimeCache && this.runtimeCache.expiresAt > Date.now()) {
      return this.runtimeCache.value;
    }
    if (this.runtimeInFlight) return this.runtimeInFlight;
    this.runtimeInFlight = this.runtimeStatus()
      .then((value) => {
        this.runtimeCache = { expiresAt: Date.now() + 2_000, value };
        return value;
      })
      .finally(() => {
        this.runtimeInFlight = null;
      });
    return this.runtimeInFlight;
  }

  private static toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
