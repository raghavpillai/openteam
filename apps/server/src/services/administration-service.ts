import {
  AGENT_DIRECTORY_DEFAULT_LIMIT,
  AGENT_DIRECTORY_MAX_LIMIT,
  AGENT_DIRECTORY_QUERY_MAX_LENGTH,
  ApiError,
  type CreateAgentInput,
  type CreateChannelInput,
  type ListAgentsInput,
  type ListGroupsInput,
  type UpdateAgentInput,
  type UpdateChannelInput,
} from "@openbot/contracts";
import { COMPUTER_API_PATHS } from "@openbot/contracts/service-protocol";
import type { Prisma, PrismaClient } from "@openbot/db";
import { type AgentDataStore, type AgentMessaging, GROUP_MAX_MEMBERS } from "@openbot/messaging";
import { Effect } from "effect";
import type { BotService } from "./bot-service";
import { appendEvent, type ComputerFetch, hashRequest, toJson } from "./service-utils";

export const CHANNEL_UPDATE_NOTHING_TO_CHANGE =
  "Nothing to change: provide add_member_ids and/or remove_member_ids.";
export const CHANNEL_UPDATE_NEEDS_MEMBER =
  "A channel needs at least one member, so this removal was not applied.";
export const channelNotFoundMessage = (channelId: string) =>
  `No channel found with id ${channelId}.`;

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const directoryQuery = (value?: string): string =>
  (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, AGENT_DIRECTORY_QUERY_MAX_LENGTH);

const directoryLimit = (value?: number): number =>
  Math.max(
    1,
    Math.min(
      AGENT_DIRECTORY_MAX_LIMIT,
      Number.isInteger(value) ? (value as number) : AGENT_DIRECTORY_DEFAULT_LIMIT
    )
  );

const directoryText = (value: string, maximum: number): string =>
  value.replace(/\s+/g, " ").trim().slice(0, maximum);

export const nextChannelMemberIds = (input: {
  current: readonly string[];
  validAdds: readonly string[];
  removes: readonly string[];
}): string[] => {
  const removes = new Set(input.removes);
  return [...new Set([...input.current, ...input.validAdds])]
    .filter((id) => !removes.has(id))
    .slice(0, GROUP_MAX_MEMBERS);
};

export class AdministrationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bots: BotService,
    private readonly messaging: AgentMessaging,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData: AgentDataStore
  ) {}

  async listAgents(parentBotId: string, input: ListAgentsInput) {
    const query = directoryQuery(input.query);
    const limit = directoryLimit(input.limit);
    const baseWhere: Prisma.BotWhereInput = {
      id: { not: parentBotId },
      status: "active",
      subagentIdentity: { is: null },
    };
    const fetch = (where: Prisma.BotWhereInput) =>
      this.prisma.bot.findMany({
        where,
        select: {
          id: true,
          name: true,
          title: true,
          description: true,
          hiddenFromSidebar: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: limit + 1,
      });

    let rows: Awaited<ReturnType<typeof fetch>>;
    if (!query) {
      rows = await fetch(baseWhere);
    } else {
      const exact = await fetch({
        AND: [
          baseWhere,
          {
            OR: [
              ...(UUID.test(query) ? [{ id: query }] : []),
              { name: { equals: query, mode: "insensitive" } },
            ],
          },
        ],
      });
      rows =
        exact.length > 0
          ? exact
          : await fetch({
              AND: [
                baseWhere,
                {
                  OR: [
                    { name: { contains: query, mode: "insensitive" } },
                    { title: { contains: query, mode: "insensitive" } },
                    { description: { contains: query, mode: "insensitive" } },
                  ],
                },
              ],
            });
    }

    return {
      query,
      agents: rows.slice(0, limit).map((agent) => ({
        id: agent.id,
        name: directoryText(agent.name, 160),
        title: directoryText(agent.title, 160),
        description: directoryText(agent.description, 500),
        hiddenFromSidebar: agent.hiddenFromSidebar,
      })),
      hasMore: rows.length > limit,
    };
  }

  async listGroups(parentBotId: string, input: ListGroupsInput) {
    const query = directoryQuery(input.query);
    const limit = directoryLimit(input.limit);
    const baseWhere: Prisma.ChannelWhereInput = {
      kind: "group",
      archivedAt: null,
      members: { some: { botId: parentBotId } },
    };
    const fetch = (where: Prisma.ChannelWhereInput) =>
      this.prisma.channel.findMany({
        where,
        select: {
          id: true,
          name: true,
          description: true,
          updatedAt: true,
          members: {
            orderBy: { ordinal: "asc" },
            take: GROUP_MAX_MEMBERS,
            select: { botId: true, bot: { select: { name: true } } },
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: limit + 1,
      });

    let rows: Awaited<ReturnType<typeof fetch>>;
    if (!query) {
      rows = await fetch(baseWhere);
    } else {
      const exact = await fetch({
        AND: [
          baseWhere,
          {
            OR: [
              ...(UUID.test(query) ? [{ id: query }] : []),
              { name: { equals: query, mode: "insensitive" } },
            ],
          },
        ],
      });
      rows =
        exact.length > 0
          ? exact
          : await fetch({
              AND: [
                baseWhere,
                {
                  OR: [
                    { name: { contains: query, mode: "insensitive" } },
                    { description: { contains: query, mode: "insensitive" } },
                  ],
                },
              ],
            });
    }

    return {
      query,
      groups: rows.slice(0, limit).map((group) => ({
        id: group.id,
        name: directoryText(group.name, 160),
        description: directoryText(group.description, 500),
        members: group.members.map((member) => ({
          id: member.botId,
          name: directoryText(member.bot.name, 160),
        })),
      })),
      hasMore: rows.length > limit,
    };
  }

  async createAgent(parentBotId: string, callId: string, input: CreateAgentInput) {
    const bot = await Effect.runPromise(
      this.bots.create({
        clientRequestId: `agent-tool:${parentBotId}:${callId}`,
        name: input.name,
        description: input.description,
        instructions: input.description,
      })
    );
    return `Created agent "${bot.name}" (id: ${bot.id}). Message it with SendToAgent using that id.`;
  }

  async updateAgent(parentBotId: string, callId: string, input: UpdateAgentInput) {
    const target = await this.prisma.bot.findUnique({
      where: { id: input.agent_id },
      include: { subagentIdentity: { select: { id: true } } },
    });
    if (!target || target.status === "archived" || target.subagentIdentity) {
      throw new ApiError(404, "agent_not_found", "Agent not found");
    }
    if (target.id === parentBotId) {
      throw new ApiError(
        400,
        "cannot_update_self",
        "UpdateAgent is only for other agents; update your own profile with update_state"
      );
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
    return `Updated agent "${bot.name}" (id: ${bot.id}).`;
  }

  async createChannel(parentBotId: string, callId: string, input: CreateChannelInput) {
    const memberIds = [...new Set(input.member_ids)];
    if (memberIds.length > GROUP_MAX_MEMBERS) {
      throw new ApiError(400, "channel_too_large", "A channel can have at most six members");
    }
    const active = await this.prisma.bot.findMany({
      where: {
        id: { in: memberIds },
        status: "active",
        subagentIdentity: { is: null },
      },
      select: { id: true, name: true },
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
        include: {
          members: { orderBy: { ordinal: "asc" }, include: { bot: true } },
        },
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
    const directory = this.workspaceRoot;
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
          include: {
            members: { orderBy: { ordinal: "asc" }, include: { bot: true } },
          },
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
      for (const botId of memberIds) {
        await this.agentData.writeGroupFilesForBot(botId);
      }
      const store = await this.computerFetch(COMPUTER_API_PATHS.agentStore(channel.id), {
        method: "PUT",
        body: JSON.stringify({ createdAt: channel.createdAt.getTime() }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!store.ok) {
        throw new ApiError(503, "group_store_unavailable", await store.text());
      }
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

  private channelResult(channel: {
    id: string;
    name: string;
    members: Array<{ botId: string; bot: { name: string } }>;
  }) {
    const members = channel.members.map(({ bot }) => bot.name).join(", ");
    return `Channel "${channel.name}" is ready (id: ${channel.id}). Members: ${members}. Post into it with SendToAgent using that id.`;
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
      if (!channel) {
        throw new ApiError(404, "channel_not_found", channelNotFoundMessage(input.channel_id));
      }

      if (!(input.add_member_ids?.length || input.remove_member_ids?.length)) {
        return {
          acknowledgement: CHANNEL_UPDATE_NOTHING_TO_CHANGE,
          memberIds: channel.members.map(({ botId }) => botId),
          affectedBotIds: [],
          changed: false,
        };
      }

      const remove = new Set(input.remove_member_ids ?? []);
      const requestedAdds = [...new Set(input.add_member_ids ?? [])];
      const validAdds = await tx.bot.findMany({
        where: {
          id: { in: requestedAdds },
          status: "active",
          subagentIdentity: { is: null },
        },
        select: { id: true },
      });
      const validAddSet = new Set(validAdds.map(({ id }) => id));
      const memberIds = nextChannelMemberIds({
        current: channel.members.map(({ botId }) => botId),
        validAdds: requestedAdds.filter((id) => validAddSet.has(id)),
        removes: [...remove],
      });
      if (memberIds.length < 1) {
        return {
          acknowledgement: CHANNEL_UPDATE_NEEDS_MEMBER,
          memberIds: channel.members.map(({ botId }) => botId),
          affectedBotIds: [],
          changed: false,
        };
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
      const members = await tx.bot.findMany({
        where: { id: { in: memberIds } },
        select: { id: true, name: true },
      });
      const namesById = new Map(members.map((member) => [member.id, member.name]));
      return {
        acknowledgement: `Updated channel "${channel.name}" (id: ${channel.id}). Members: ${memberIds.map((id) => namesById.get(id) ?? id).join(", ")}.`,
        memberIds,
        affectedBotIds: [...new Set([...previous, ...memberIds])],
        changed: true,
      };
    });
    if (result.changed) {
      for (const botId of result.affectedBotIds) {
        await this.agentData.writeGroupFilesForBot(botId);
      }
    }
    return result.acknowledgement;
  }
}
