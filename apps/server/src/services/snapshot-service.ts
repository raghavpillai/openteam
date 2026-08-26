import { resolve } from "node:path";
import type { ClientSnapshot, Snapshot } from "@openbot/contracts";
import type { PrismaClient } from "@openbot/db";
import { Effect } from "effect";
import { serialize, toBotView } from "./view-mappers";

const COMPUTER_ID = "00000000-0000-0000-0000-000000000001";

export class SnapshotService {
  private runtimeCache: { expiresAt: number; value: Snapshot["runtime"] } | null = null;
  private runtimeInFlight: Promise<Snapshot["runtime"]> | null = null;

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
          this.prisma.event.findFirst({
            orderBy: { sequence: "desc" },
            select: { sequence: true },
          }),
          this.runtimeStatus(),
        ]);
        return serialize({
          cursor: cursor?.sequence.toString() ?? "0",
          workspace: this.workspaceView(),
          bots: bots
            .filter((bot) => bot.conversation)
            .filter((bot) =>
              bot.channelMemberships.some((membership) => membership.channel.kind === "bot_dm")
            )
            .map(toBotView),
          channels: this.channelViews(channels),
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
          approvals: approvals.map((approval) => ({
            ...approval,
            createdAt: approval.createdAt.toISOString(),
          })),
          runtime,
        });
      },
      catch: SnapshotService.toError,
    });

  client = () =>
    Effect.tryPromise({
      try: async (): Promise<ClientSnapshot> => {
        const [bots, channels, cursor, runtime] = await Promise.all([
          this.prisma.bot.findMany({
            where: { status: { not: "archived" }, hiddenFromSidebar: false },
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
              members: { some: { bot: { hiddenFromSidebar: false } } },
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
        const [channelMessages, channelRounds, runs] = await Promise.all([
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
        ]);
        const runIds = runs.map((run) => run.id);
        const [runItems, approvals] = await Promise.all([
          this.prisma.runItem.findMany({
            where: { runId: { in: runIds }, kind: { notIn: ["agent_message", "reasoning"] } },
            orderBy: { createdAt: "asc" },
          }),
          this.prisma.approval.findMany({
            where: { runId: { in: runIds } },
            orderBy: { createdAt: "asc" },
          }),
        ]);
        return serialize({
          cursor: cursor?.sequence.toString() ?? "0",
          workspace: this.workspaceView(),
          bots: bots
            .filter((bot) => bot.conversation)
            .filter((bot) =>
              bot.channelMemberships.some((membership) => membership.channel.kind === "bot_dm")
            )
            .map(toBotView),
          channels: this.channelViews(channels),
          channelMessages: this.messageViews(channelMessages),
          channelRounds: this.roundViews(channelRounds),
          runs: this.runViews(runs),
          runItems: runItems.map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
            updatedAt: item.updatedAt.toISOString(),
          })),
          approvals: approvals.map((approval) => ({
            ...approval,
            createdAt: approval.createdAt.toISOString(),
          })),
          runtime,
        });
      },
      catch: SnapshotService.toError,
    });

  health = () =>
    Effect.tryPromise({
      try: () => this.runtimeStatusCached(),
      catch: SnapshotService.toError,
    });

  async eventsAfter(sequence: bigint) {
    const events = await this.prisma.event.findMany({
      where: { sequence: { gt: sequence } },
      orderBy: { sequence: "asc" },
      take: 200,
    });
    return events.map((event) => ({
      sequence: event.sequence.toString(),
      topic: event.topic,
      entityId: event.entityId,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    }));
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
      directKey: string | null;
      workingDirectory: string | null;
      members: Array<{ botId: string; ordinal: number }>;
      createdAt: Date;
      updatedAt: Date;
    }>,
  >(channels: T) {
    return channels.map((channel) => ({
      id: channel.id,
      kind: channel.kind as Snapshot["channels"][number]["kind"],
      name: channel.name,
      directKey: channel.directKey,
      workingDirectory: channel.workingDirectory,
      members: channel.members.map((member) => ({ botId: member.botId, ordinal: member.ordinal })),
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
    }));
  }

  private messageViews<
    T extends Array<{
      id: string;
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
    let agent: Snapshot["runtime"]["agent"] = "unavailable";
    try {
      const response = await fetch(`${this.computerUrl}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      const body = (await response.json()) as {
        status?: string;
        agent?: { ready?: boolean; authenticated?: boolean };
      };
      computer = response.ok && body.status === "ready" ? "ready" : "unavailable";
      agent = body.agent?.ready ? (body.agent.authenticated ? "ready" : "missing") : "unavailable";
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
      agent,
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
