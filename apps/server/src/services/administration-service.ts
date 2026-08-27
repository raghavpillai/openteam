import { resolve, sep } from "node:path";
import {
  ApiError,
  type CreateAgentInput,
  type CreateChannelInput,
  type UpdateAgentInput,
  type UpdateChannelInput,
} from "@openbot/contracts";
import type { PrismaClient } from "@openbot/db";
import type { AgentDataStore, AgentMessaging } from "@openbot/messaging";
import { Effect } from "effect";
import type { BotService } from "./bot-service";
import { appendEvent, type ComputerFetch, hashRequest, slugify, toJson } from "./service-utils";

export class AdministrationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bots: BotService,
    private readonly messaging: AgentMessaging,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData: AgentDataStore
  ) {}

  async createAgent(parentBotId: string, callId: string, input: CreateAgentInput) {
    const bot = await Effect.runPromise(
      this.bots.create({
        clientRequestId: `agent-tool:${parentBotId}:${callId}`,
        name: input.name,
        description: input.description,
        instructions: input.description,
      })
    );
    return {
      agent_id: bot.id,
      name: bot.name,
      description: bot.description,
      status: bot.status,
    };
  }

  async updateAgent(parentBotId: string, callId: string, input: UpdateAgentInput) {
    const target = await this.prisma.bot.findUnique({
      where: { id: input.agent_id },
      include: { subagentIdentity: { select: { id: true } } },
    });
    if (
      !target ||
      target.hiddenFromSidebar ||
      target.status === "archived" ||
      target.subagentIdentity
    ) {
      throw new ApiError(404, "agent_not_found", "Agent not found");
    }
    if (input.name !== undefined && input.name.trim().length === 0) {
      throw new ApiError(400, "agent_name_required", "An agent name cannot be cleared");
    }
    if (input.description !== undefined && input.description.trim().length === 0) {
      throw new ApiError(
        400,
        "agent_description_required",
        "An agent description cannot be cleared"
      );
    }
    const bot = await Effect.runPromise(
      this.bots.update(input.agent_id, {
        name: input.name,
        description: input.description,
        instructions: input.description,
      })
    );
    await this.prisma.$transaction((tx) =>
      appendEvent(tx, "agent.profile_updated_by_agent", bot.id, {
        initiatorBotId: parentBotId,
        callId,
        agentId: bot.id,
      })
    );
    return { agent_id: bot.id, name: bot.name, description: bot.description };
  }

  async createChannel(parentBotId: string, callId: string, input: CreateChannelInput) {
    const memberIds = [...new Set(input.member_ids)];
    if (memberIds.length > 6) {
      throw new ApiError(400, "channel_too_large", "A channel can have at most six members");
    }
    const active = await this.prisma.bot.findMany({
      where: {
        id: { in: memberIds },
        status: "active",
        hiddenFromSidebar: false,
        subagentIdentity: { is: null },
      },
      select: { id: true },
    });
    if (active.length !== memberIds.length) {
      throw new ApiError(400, "invalid_channel_members", "Every channel member must be an agent");
    }
    const scope = `channel-tool:create:${parentBotId}`;
    const requestHash = hashRequest(input);
    const previous = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope, key: callId } },
    });
    if (previous && previous.requestHash !== requestHash) {
      throw new ApiError(409, "idempotency_conflict", "This channel creation call id was reused");
    }
    const previousChannelId = this.receiptChannelId(previous?.response);
    if (previousChannelId) {
      const replay = await this.prisma.channel.findUnique({
        where: { id: previousChannelId },
        include: { members: { orderBy: { ordinal: "asc" } } },
      });
      if (replay) return this.channelResult(replay);
    }
    const channelId = previousChannelId ?? crypto.randomUUID();
    if (!previous) {
      try {
        await this.prisma.idempotencyRecord.create({
          data: {
            scope,
            key: callId,
            requestHash,
            response: toJson({ channelId }),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
        throw new ApiError(409, "request_in_progress", "This channel is already being created");
      }
    }
    const directory = resolve(
      this.workspaceRoot,
      "projects",
      `${slugify(input.name)}-${channelId.slice(0, 8)}`
    );
    if (!directory.startsWith(`${this.workspaceRoot}${sep}`)) {
      throw new ApiError(400, "invalid_workspace", "Generated project path escaped root");
    }
    try {
      const provisioned = await this.computerFetch("/v1/directories", {
        method: "PUT",
        body: JSON.stringify({ paths: [directory] }),
      });
      if (!provisioned.ok) {
        throw new ApiError(503, "computer_unavailable", await provisioned.text());
      }
      const channel = await this.prisma.$transaction(async (tx) => {
        const created = await tx.channel.create({
          data: {
            id: channelId,
            kind: "group",
            name: input.name.trim(),
            workingDirectory: directory,
            members: {
              create: memberIds.map((botId, ordinal) => ({ botId, ordinal })),
            },
          },
          include: { members: { orderBy: { ordinal: "asc" } } },
        });
        await appendEvent(tx, "channel.created_by_agent", channelId, {
          initiatorBotId: parentBotId,
          callId,
          channelId,
          memberIds,
          workingDirectory: directory,
        });
        await this.messaging.scheduleTranscriptProjection(tx, memberIds);
        await tx.idempotencyRecord.update({
          where: { scope_key: { scope, key: callId } },
          data: { status: "completed" },
        });
        return created;
      });
      return this.channelResult(channel);
    } catch (error) {
      await this.prisma.idempotencyRecord.deleteMany({
        where: { scope, key: callId, status: "processing" },
      });
      throw error;
    }
  }

  private receiptChannelId(response: unknown): string | null {
    return response &&
      typeof response === "object" &&
      !Array.isArray(response) &&
      typeof (response as Record<string, unknown>).channelId === "string"
      ? ((response as Record<string, unknown>).channelId as string)
      : null;
  }

  private channelResult(channel: { id: string; name: string; members: Array<{ botId: string }> }) {
    return {
      channel_id: channel.id,
      name: channel.name,
      member_ids: channel.members.map(({ botId }) => botId),
    };
  }

  async updateChannel(parentBotId: string, callId: string, input: UpdateChannelInput) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel:${input.channel_id}`}))`;
      const channel = await tx.channel.findFirst({
        where: {
          id: input.channel_id,
          kind: "group",
          archivedAt: null,
          members: { some: { botId: parentBotId } },
        },
        include: { members: { orderBy: { ordinal: "asc" } } },
      });
      if (!channel) throw new ApiError(404, "channel_not_found", "Channel not found");

      const remove = new Set(input.remove_member_ids ?? []);
      const retained = channel.members
        .map(({ botId }) => botId)
        .filter((botId) => !remove.has(botId));
      const requestedAdds = [...new Set(input.add_member_ids ?? [])];
      const validAdds = await tx.bot.findMany({
        where: {
          id: { in: requestedAdds },
          status: "active",
          hiddenFromSidebar: false,
          subagentIdentity: { is: null },
        },
        select: { id: true },
      });
      const memberIds = [...new Set([...retained, ...validAdds.map(({ id }) => id)])];
      if (memberIds.length < 1) {
        throw new ApiError(400, "channel_members_required", "A channel must keep one member");
      }
      if (memberIds.length > 6) {
        throw new ApiError(400, "channel_too_large", "A channel can have at most six members");
      }
      const previous = channel.members.map(({ botId }) => botId);
      await tx.channelMember.deleteMany({ where: { channelId: channel.id } });
      await tx.channelMember.createMany({
        data: memberIds.map((botId, ordinal) => ({
          channelId: channel.id,
          botId,
          ordinal,
        })),
      });
      await tx.channel.update({
        where: { id: channel.id },
        data: { updatedAt: new Date() },
      });
      await appendEvent(tx, "channel.members_updated_by_agent", channel.id, {
        initiatorBotId: parentBotId,
        callId,
        channelId: channel.id,
        previousMemberIds: previous,
        memberIds,
        ignoredMemberIds: requestedAdds.filter((id) => !validAdds.some((bot) => bot.id === id)),
      });
      await this.messaging.scheduleTranscriptProjection(tx, [
        ...new Set([...previous, ...memberIds]),
      ]);
      return {
        channel_id: channel.id,
        name: channel.name,
        member_ids: memberIds,
      };
    });
    await this.agentData.writeGroupFilesForBot(result.member_ids[0]!);
    return result;
  }
}
