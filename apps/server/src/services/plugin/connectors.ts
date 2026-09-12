import { ApiError } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import type { AgentDataStore } from "@openteam/messaging";
import { Effect } from "effect";
import type { McpHttpClientManager } from "../../plugins/mcp-client-manager";
import { toJson } from "../service-utils";
import type { PluginTransport } from "./transport";
import {
  channelDeliveryArguments,
  channelDeliveryTool,
  jsonObject,
  normalizedConnectorKey,
  toolSnapshot,
} from "./values";

export class PluginConnectors {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly http: McpHttpClientManager,
    private readonly connect: (connectionId: string) => Effect.Effect<unknown, Error>,
    private readonly executeInvocation: PluginTransport["executeInvocation"],
    private readonly agentData?: Pick<
      AgentDataStore,
      "syncPluginSkillCache" | "writeConnectorSecret"
    >
  ) {}
  storeConnectorSecret = async (input: {
    botId: string;
    connector: string;
    field: string;
    value: string;
  }): Promise<void> => {
    await this.agentData?.writeConnectorSecret(
      input.botId,
      input.connector,
      input.field,
      input.value
    );
    const normalized = input.connector.trim().toLowerCase().replaceAll("_", "-");
    const grants = await this.prisma.botPluginConnectionGrant.findMany({
      where: {
        botId: input.botId,
        enabled: true,
        connection: {
          installation: { status: "installed" },
        },
      },
      include: { connection: { include: { installation: true } } },
    });
    const match = grants.find(({ connection }) =>
      [connection.connectorKey, connection.installation.pluginKey]
        .map((value) => value.toLowerCase().replaceAll("_", "-"))
        .includes(normalized)
    )?.connection;
    if (!match) return;
    const credentials = jsonObject(match.credentials);
    const tokenLike = /^(?:token|bearer[-_.]?token|api[-_.]?key)$/i.test(input.field);
    await this.prisma.pluginConnection.update({
      where: { id: match.id },
      data: {
        credentials: toJson({
          ...credentials,
          [input.field]: input.value,
          ...(tokenLike ? { bearerToken: input.value } : {}),
        }),
        status: "disconnected",
        statusMessage: null,
      },
    });
    await this.http.close(match.id);
    void Effect.runPromise(this.connect(match.id)).catch(async (error) => {
      await this.prisma.pluginConnection
        .update({
          where: { id: match.id },
          data: {
            status: "error",
            statusMessage: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
            lastCheckedAt: new Date(),
          },
        })
        .catch(() => undefined);
    });
  };

  deliverConnectedChannel = async (input: {
    botId: string;
    runId: string;
    callId: string;
    address: string;
    content: string;
  }): Promise<{ connectionId: string; toolName: string; result: unknown }> => {
    const delimiter = input.address.indexOf(":");
    const platform = delimiter > 0 ? input.address.slice(0, delimiter) : "";
    const chat = delimiter > 0 ? input.address.slice(delimiter + 1).trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(platform) || !chat || chat.length > 500) {
      throw new ApiError(
        400,
        "connected_channel_address_invalid",
        "Connected channel addresses must be shaped platform:chat"
      );
    }
    const normalized = normalizedConnectorKey(platform);
    const grants = await this.prisma.botPluginConnectionGrant.findMany({
      where: {
        botId: input.botId,
        enabled: true,
        connection: {
          status: "ready",
          installation: {
            status: "installed",
            enablements: { some: { botId: input.botId, enabled: true } },
          },
        },
      },
      include: { connection: { include: { installation: true } } },
      orderBy: { connection: { createdAt: "asc" } },
    });
    const connection = grants.find(({ connection: candidate }) =>
      [candidate.connectorKey, candidate.installation.pluginKey]
        .map(normalizedConnectorKey)
        .includes(normalized)
    )?.connection;
    if (!connection) {
      throw new ApiError(
        409,
        "connected_channel_unavailable",
        `No ready ${platform} connection is granted to this agent`
      );
    }
    const tool = channelDeliveryTool(toolSnapshot(connection.toolSnapshot));
    if (!tool) {
      throw new ApiError(
        409,
        "connected_channel_delivery_unsupported",
        `${connection.name} does not expose a message delivery tool`
      );
    }
    const callId = `connected-channel:${input.callId}`;
    const previous = await this.prisma.pluginInvocation.findUnique({ where: { callId } });
    if (previous?.status === "completed") {
      return { connectionId: connection.id, toolName: tool.name, result: previous.result };
    }
    if (previous) {
      throw new ApiError(
        409,
        "connected_channel_delivery_replayed",
        `Connected channel delivery is already ${previous.status}`
      );
    }
    await this.prisma.pluginInvocation.create({
      data: {
        callId,
        connectionId: connection.id,
        botId: input.botId,
        runId: input.runId,
        toolName: tool.name,
        decision: "allow",
        arguments: toJson(channelDeliveryArguments(tool, chat, input.content)),
      },
    });
    const result = await this.executeInvocation(callId);
    return { connectionId: connection.id, toolName: tool.name, result };
  };
}
