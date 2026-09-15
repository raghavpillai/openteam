import {deliverExternalFiles, type ExternalFile} from "./external-files";
import {createHash} from "node:crypto";
import {effectiveToolPolicy} from "@openteam/plugin-sdk";
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
  canonicalJson,
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
    >,
    private readonly providerToken?: (connectionId: string) => Promise<string>
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
    files?: ExternalFile[];
    reviewedExternal?: boolean;
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
            mode: {not:"disabled"},
            enablements: { some: { botId: input.botId, enabled: true } },
          },
        },
      },
      include: { connection: { include: { installation: true } } },
      orderBy: { connection: { createdAt: "asc" } },
    });
    const matches = grants.filter(({ connection: candidate }) =>
      [candidate.connectorKey, candidate.installation.pluginKey, candidate.id]
        .map(normalizedConnectorKey).includes(normalized)
    );
    if(matches.length>1)throw new ApiError(409,"connected_channel_ambiguous","Multiple accounts match this service; use the connection ID as the channel platform");
    const connection=matches[0]?.connection;
    if (!connection) {
      throw new ApiError(
        409,
        "connected_channel_unavailable",
        `No ready ${platform} connection is granted to this agent`
      );
    }
    if (input.files?.length) {
      if(input.files.length>10||input.files.reduce((sum,file)=>sum+file.bytes.length,0)>64*1024*1024)throw new Error("External delivery supports at most 10 files totaling 64 MiB");
      if(!this.providerToken)throw new Error("Native file delivery is unavailable");
      const toolName="deliver_files";
      const policies=await this.prisma.pluginToolPolicy.findMany({where:{connectionId:connection.id,OR:[{botId:input.botId},{botId:null}]}});
      const policy=effectiveToolPolicy(policies,toolName,input.botId,"allow");
      let needsReview=policy.decision==="prompt";
      if(!policy.enabled||policy.decision==="deny")throw new Error("Native file delivery is not allowed by this account policy");
      // Binary delivery is the same external write as the account's send/upload
      // tools. A new implementation path must not circumvent those policies.
      const deliveryNames = new Set(toolSnapshot(connection.toolSnapshot).filter(tool => /send|post.?message|upload|attach|deliver/i.test(tool.name)).map(tool => tool.name));
      for (const policy of policies) if (/send|post.?message|upload|attach|deliver/i.test(policy.toolName)) deliveryNames.add(policy.toolName);
      for (const name of deliveryNames) {
        const inherited = effectiveToolPolicy(policies, name, input.botId, "allow");
        needsReview ||= inherited.decision === "prompt";
        if (!inherited.enabled || inherited.decision === "deny") throw new Error(`Native file delivery requires an allowed ${name} policy on this account`);
      }
      const callId=`connected-channel:${input.callId}`;
      const argumentsValue={target:chat,content:input.content,files:input.files.map(file=>({assetId:file.assetId,name:file.name,mimeType:file.mimeType,sizeBytes:file.bytes.length,sha256:createHash("sha256").update(file.bytes).digest("hex")}))};
      const previous=await this.prisma.pluginInvocation.findUnique({where:{callId}});
      if(previous&&(previous.connectionId!==connection.id||previous.botId!==input.botId||previous.runId!==input.runId||canonicalJson(previous.arguments)!==canonicalJson(argumentsValue)))throw new Error("Delivery account, recipient, content or file bytes changed after staging; request a new review");
      if(previous?.status==="completed")return {connectionId:previous.connectionId,toolName,result:previous.result};
      if(previous&&!(previous.status==="running"&&previous.error==="Approval required"&&previous.decision==="prompt"))throw new Error("This delivery's outcome is uncertain; inspect the destination before retrying");
      if(!previous)await this.prisma.pluginInvocation.create({data:{callId,connectionId:connection.id,botId:input.botId,runId:input.runId,toolName,decision:needsReview?"prompt":"allow",arguments:toJson(argumentsValue),error:needsReview?"Approval required":null}});
      if(needsReview&&!input.reviewedExternal)throw new ApiError(409,"external_file_review_required","This connected account requires review before delivering files",{connectionId:connection.id,connectionName:connection.name,...argumentsValue});
      if(previous||needsReview){const claimed=await this.prisma.pluginInvocation.updateMany({where:{callId,status:"running",decision:"prompt",error:"Approval required"},data:{decision:"allow",error:null}});if(!claimed.count)throw new Error("This reviewed delivery has already started");}
      try {
        const result=await deliverExternalFiles(connection.installation.pluginKey,await this.providerToken(connection.id),chat,input.content,input.files);
        await this.prisma.pluginInvocation.update({where:{callId},data:{status:"completed",result:toJson(result),completedAt:new Date()}});
        return {connectionId:connection.id,toolName,result};
      } catch(error) {await this.prisma.pluginInvocation.update({where:{callId},data:{status:"failed",error:"Native file delivery failed; inspect destination before retrying",completedAt:new Date()}});throw error;}
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
